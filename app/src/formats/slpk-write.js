// Scene layer package writer (REQ-GAP-35): a 3DObject I3S layer (version 1.8 layout, with the
// 1.6 node index documents older clients read) from the app's building models and terrain
// meshes. Checked with Esri's i3s_converter (-v) and read back by formats/i3s-scene.js.
// Layout:
// - one feature per object (a building, or the terrain), with OBJECTID and the object's
//   attributes as binary attribute resources (Oid32, Float64, UTF-8 strings);
// - leaf nodes of at most `maxVertices` vertices and `maxFeatures` features, split at the median
//   of the feature centres along the longer horizontal axis; inner nodes carry no mesh (as Esri's
//   own packages); 64 nodes per node page;
// - geometry: the uncompressed buffer (position offsets from the node's OBB centre in degrees and
//   metres, east-north-up normals, uv0, colour, feature id, face range), gzip-compressed; no Draco
//   buffer (it is optional, and its encoder is not in this file);
// - textures: one JPEG or PNG per textured node (texture set 0, name "0");
// - OBB per node in ECEF (east-north-up axes at the node centre), quaternion as I3S defines it;
// - heights: above the WGS 84 ellipsoid (heightModelInfo ellipsoidal, vcsWkid 115700);
// - the archive: STORE, every resource gzip-compressed, the MD5 hash index
//   @specialIndexFileHASH128@ as the last entry.

import { zipSync, gzipSync } from 'fflate';
import { md5, geoToEcef } from './tiles3d-write.js';

const te = new TextEncoder();
const gz = (u8) => gzipSync(u8, { level: 6, mtime: 0 });
const jgz = (o) => gz(te.encode(JSON.stringify(o)));

/** Rotation matrix (rows) → quaternion [x, y, z, w]. */
function quat(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const tr = a + e + i;
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4;
    x = (h - f) / s;
    y = (c - g) / s;
    z = (d - b) / s;
  } else if (a > e && a > i) {
    const s = Math.sqrt(1 + a - e - i) * 2;
    w = (h - f) / s;
    x = s / 4;
    y = (b + d) / s;
    z = (c + g) / s;
  } else if (e > i) {
    const s = Math.sqrt(1 + e - a - i) * 2;
    w = (c - g) / s;
    x = (b + d) / s;
    y = s / 4;
    z = (f + h) / s;
  } else {
    const s = Math.sqrt(1 + i - a - e) * 2;
    w = (d - b) / s;
    x = (c + g) / s;
    y = (f + h) / s;
    z = s / 4;
  }
  return [x, y, z, w];
}

/** East, north, up unit vectors (ECEF) at lat, lon (degrees). */
function enuAxes(lat, lon) {
  const [la, lo] = [(lat * Math.PI) / 180, (lon * Math.PI) / 180];
  return [
    [-Math.sin(lo), Math.cos(lo), 0],
    [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)],
    [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)],
  ];
}

const A = 6378137;
const E2 = 0.0066943799901413165;
function ecefToGeo(x, y, z) {
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
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI, h];
}

/**
 * The OBB of points given as lon/lat/h (Float64Array): ENU axes at their mean position, centre
 * the middle of the extents. → {center [lon, lat, h], halfSize [m], quaternion [x, y, z, w]}.
 */
export function obbOf(geo) {
  const n = geo.length / 3;
  let lon = 0;
  let lat = 0;
  let hh = 0;
  for (let i = 0; i < n; i++) {
    lon += geo[3 * i];
    lat += geo[3 * i + 1];
    hh += geo[3 * i + 2];
  }
  lon /= n;
  lat /= n;
  hh /= n;
  const ax = enuAxes(lat, lon);
  const o = geoToEcef(lat, lon, hh);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const p = geoToEcef(geo[3 * i + 1], geo[3 * i], geo[3 * i + 2]);
    const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    for (let k = 0; k < 3; k++) {
      const v = d[0] * ax[k][0] + d[1] * ax[k][1] + d[2] * ax[k][2];
      lo[k] = Math.min(lo[k], v);
      hi[k] = Math.max(hi[k], v);
    }
  }
  const mid = lo.map((l, k) => (l + hi[k]) / 2);
  const c = [0, 1, 2].map((j) => o[j] + mid[0] * ax[0][j] + mid[1] * ax[1][j] + mid[2] * ax[2][j]);
  // R maps OBB axes to ECEF: its columns are E, N, U.
  const R = [0, 1, 2].map((r) => [ax[0][r], ax[1][r], ax[2][r]]);
  return { center: ecefToGeo(...c), halfSize: lo.map((l, k) => Math.max(0.005, (hi[k] - l) / 2)), quaternion: quat(R) };
}

/**
 * Objects for the writer from the app's models (vector/mesh.js shape: {id, name, model
 * {vertices, faces [{idx}]}, attrs}): triangle soups in local metres. `tris(V, idx)` splits a
 * face into triangles (faceTriangles); `uv(x, y, z)` gives texture coordinates when textured.
 */
export function objectsFromModels(models, tris, { uv = null } = {}) {
  return models.map((m, i) => {
    const V = m.model.vertices;
    const p = [];
    const t = [];
    for (const f of m.model.faces) {
      const list = f.idx.length === 3 ? [f.idx] : tris(V, f.idx);
      for (const tri of list)
        for (const vi of tri) {
          p.push(V[vi][0], V[vi][1], V[vi][2]);
          if (uv) t.push(...uv(V[vi][0], V[vi][1], V[vi][2]));
        }
    }
    return { id: m.id ?? i, name: m.name ?? String(m.id ?? i), attrs: m.attrs ?? {}, positions: Float64Array.from(p), uv: uv ? Float32Array.from(t) : null };
  });
}

/** {width, height} of a PNG or baseline/progressive JPEG, or null. */
export function imageSize(b) {
  if (b[0] === 0x89 && b[1] === 0x50) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) return null;
    const m = b[p + 1];
    const len = (b[p + 2] << 8) | b[p + 3];
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) return { height: (b[p + 5] << 8) | b[p + 6], width: (b[p + 7] << 8) | b[p + 8] };
    p += 2 + len;
  }
  return null;
}

/** Leaf groups of object indices (median splits on the centres). */
function partition(objs, centres, { maxVertices, maxFeatures }) {
  const leaves = [];
  const split = (ids) => {
    const nv = ids.reduce((s, i) => s + objs[i].positions.length / 3, 0);
    if (ids.length <= 1 || (nv <= maxVertices && ids.length <= maxFeatures)) {
      leaves.push(ids);
      return;
    }
    const xs = ids.map((i) => centres[i][0]);
    const ys = ids.map((i) => centres[i][1]);
    const ax = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys) ? 0 : 1;
    const s = [...ids].sort((a, b) => centres[a][ax] - centres[b][ax]);
    const h = s.length >> 1;
    split(s.slice(0, h));
    split(s.slice(h));
  };
  split(objs.map((_, i) => i));
  return leaves;
}

/** One attribute resource: Oid32/Int32/Float64 values or UTF-8 strings (I3S attributeStorageInfo). */
function attributeBytes(type, values) {
  const n = values.length;
  if (type === 'String') {
    const enc = values.map((v) => te.encode(`${v ?? ''}\0`));
    const total = enc.reduce((s, b) => s + b.length, 0);
    const out = new Uint8Array(8 + 4 * n + total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, n, true);
    dv.setUint32(4, total, true);
    let o = 8 + 4 * n;
    enc.forEach((b, i) => {
      dv.setUint32(8 + 4 * i, b.length, true);
      out.set(b, o);
      o += b.length;
    });
    return out;
  }
  if (type === 'Float64') {
    // Count, then 4 bytes of padding: 8-byte values start 8-byte aligned.
    const out = new Uint8Array(8 + 8 * n);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, n, true);
    values.forEach((v, i) => dv.setFloat64(8 + 8 * i, Number.isFinite(Number(v)) ? Number(v) : NaN, true));
    return out;
  }
  const out = new Uint8Array(4 + 4 * n);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, n, true);
  values.forEach((v, i) => (type === 'Int32' ? dv.setInt32(4 + 4 * i, v, true) : dv.setUint32(4 + 4 * i, v, true)));
  return out;
}

const guid = () => {
  const h = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
};

/**
 * Write a 3DObject SLPK. `objects` = [{id, name, attrs, positions (Float64Array, local metres,
 * triangle soup), uv (Float32Array) | null}]; `toGeo(x, y, z)` → [lon, lat, h above the
 * ellipsoid]; `texture` = {bytes, format 'jpg' | 'png'} shared by the textured objects;
 * `colour` = [r, g, b] 0..1 for untextured ones. → {bytes, nodes, leaves, vertices, features}.
 */
export function writeSlpk({ name = 'GIS Workbench', objects, toGeo, texture = null, colour = [0.82, 0.78, 0.72] }, { maxVertices = 65535, maxFeatures = 2000, nodesPerPage = 64, onProgress = null } = {}) {
  if (!objects.length) throw new Error('nothing to write: no objects');
  // Geographic positions of every vertex, and each object's centre (lon, lat).
  const geos = objects.map((o) => {
    const n = o.positions.length / 3;
    const g = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) g.set(toGeo(o.positions[3 * i], o.positions[3 * i + 1], o.positions[3 * i + 2]), 3 * i);
    return g;
  });
  const centres = geos.map((g) => {
    let x = 0;
    let y = 0;
    const n = g.length / 3;
    for (let i = 0; i < n; i++) {
      x += g[3 * i];
      y += g[3 * i + 1];
    }
    return [x / n, y / n];
  });
  const leaves = partition(objects, centres, { maxVertices, maxFeatures });
  // Field schema: OBJECTID, NAME, then each attribute key (Float64 when every value is a number, else String).
  const keys = [...new Set(objects.flatMap((o) => Object.keys(o.attrs ?? {})))].filter((k) => k !== 'OBJECTID' && k !== 'NAME').sort();
  const numeric = (k) => objects.every((o) => o.attrs?.[k] == null || (typeof o.attrs[k] === 'number' && Number.isFinite(o.attrs[k])));
  const fields = [
    { name: 'OBJECTID', type: 'esriFieldTypeOID', alias: 'OBJECTID', vt: 'Oid32', get: (o, i) => i + 1 },
    { name: 'NAME', type: 'esriFieldTypeString', alias: 'NAME', vt: 'String', get: (o) => o.name ?? '' },
    ...keys.map((k) => (numeric(k) ? { name: k, type: 'esriFieldTypeDouble', alias: k, vt: 'Float64', get: (o) => o.attrs?.[k] ?? NaN } : { name: k, type: 'esriFieldTypeString', alias: k, vt: 'String', get: (o) => (o.attrs?.[k] == null ? '' : String(o.attrs[k])) })),
  ];
  const storage = fields.map((f, i) => ({
    key: `f_${i}`,
    name: f.name,
    header: f.vt === 'String' ? [{ property: 'count', valueType: 'UInt32' }, { property: 'attributeValuesByteCount', valueType: 'UInt32' }] : [{ property: 'count', valueType: 'UInt32' }],
    ordering: f.vt === 'String' ? ['attributeByteCounts', 'attributeValues'] : ['attributeValues'],
    ...(f.vt === 'String' ? { attributeByteCounts: { valueType: 'UInt32', valuesPerElement: 1 }, attributeValues: { valueType: 'String', encoding: 'UTF-8', valuesPerElement: 1 } } : { attributeValues: { valueType: f.vt, valuesPerElement: 1 } }),
  }));
  const files = {};
  const nodes = [];
  // Inner nodes: the root, and a level of groups when there are more leaves than fit one node's children.
  const fanout = 64;
  const root = { index: 0, children: [], leafs: leaves.map((_, i) => i) };
  nodes.push(root);
  const leafNode = new Map();
  const build = (parent, leafIds, level) => {
    if (leafIds.length <= fanout) {
      for (const l of leafIds) {
        const n = { index: nodes.length, parentIndex: parent.index, children: [], leaf: l, level };
        nodes.push(n);
        parent.children.push(n.index);
        leafNode.set(l, n);
      }
      return;
    }
    const per = Math.ceil(leafIds.length / fanout);
    for (let i = 0; i < leafIds.length; i += per) {
      const n = { index: nodes.length, parentIndex: parent.index, children: [], level };
      nodes.push(n);
      parent.children.push(n.index);
      build(n, leafIds.slice(i, i + per), level + 1);
    }
  };
  build(root, root.leafs, 1);
  // Leaves: geometry, attributes, texture.
  const dim = texture ? imageSize(texture.bytes) : null;
  const texels = dim ? dim.width * dim.height : 0;
  let vertices = 0;
  const leafGeo = new Map();
  leaves.forEach((ids, li) => {
    const n = leafNode.get(li);
    const nv = ids.reduce((s, i) => s + objects[i].positions.length / 3, 0);
    const all = new Float64Array(3 * nv);
    let o = 0;
    for (const i of ids) {
      all.set(geos[i], o);
      o += geos[i].length;
    }
    const obb = obbOf(all);
    n.obb = obb;
    leafGeo.set(li, all);
    const textured = !!texture && ids.some((i) => objects[i].uv);
    const head = 8;
    const size = head + nv * (12 + 12 + 8 + 4) + ids.length * (8 + 8);
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, nv, true);
    dv.setUint32(4, ids.length, true);
    let pPos = head;
    let pNrm = pPos + 12 * nv;
    let pUv = pNrm + 12 * nv;
    let pCol = pUv + 8 * nv;
    let pFid = pCol + 4 * nv;
    let pFr = pFid + 8 * ids.length;
    let tri = 0;
    const [cl, ca, ch] = obb.center;
    ids.forEach((i) => {
      const ob = objects[i];
      const g = geos[i];
      const m = ob.positions.length / 3;
      for (let v = 0; v < m; v++) {
        dv.setFloat32(pPos, g[3 * v] - cl, true);
        dv.setFloat32(pPos + 4, g[3 * v + 1] - ca, true);
        dv.setFloat32(pPos + 8, g[3 * v + 2] - ch, true);
        pPos += 12;
      }
      // Face normals in the local (east-north-up) frame of the positions.
      const P = ob.positions;
      for (let t = 0; t < m; t += 3) {
        const ux = P[3 * t + 3] - P[3 * t];
        const uy = P[3 * t + 4] - P[3 * t + 1];
        const uz = P[3 * t + 5] - P[3 * t + 2];
        const wx = P[3 * t + 6] - P[3 * t];
        const wy = P[3 * t + 7] - P[3 * t + 1];
        const wz = P[3 * t + 8] - P[3 * t + 2];
        let nx = uy * wz - uz * wy;
        let ny = uz * wx - ux * wz;
        let nz = ux * wy - uy * wx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        for (let k = 0; k < 3; k++) {
          dv.setFloat32(pNrm, nx, true);
          dv.setFloat32(pNrm + 4, ny, true);
          dv.setFloat32(pNrm + 8, nz, true);
          pNrm += 12;
        }
      }
      for (let v = 0; v < m; v++) {
        dv.setFloat32(pUv, ob.uv ? ob.uv[2 * v] : 0, true);
        dv.setFloat32(pUv + 4, ob.uv ? ob.uv[2 * v + 1] : 0, true);
        pUv += 8;
        buf.fill(255, pCol, pCol + 4);
        pCol += 4;
      }
      dv.setBigUint64(pFid, BigInt(i + 1), true);
      pFid += 8;
      dv.setUint32(pFr, tri, true);
      dv.setUint32(pFr + 4, tri + m / 3 - 1, true);
      pFr += 8;
      tri += m / 3;
    });
    vertices += nv;
    const r = n.index;
    files[`nodes/${r}/geometries/0.bin.gz`] = gz(buf);
    storage.forEach((s, k) => {
      files[`nodes/${r}/attributes/${s.key}/0.bin.gz`] = gz(attributeBytes(fields[k].vt, ids.map((i) => fields[k].get(objects[i], i))));
    });
    if (textured) files[`nodes/${r}/textures/0.${texture.format === 'png' ? 'png' : 'jpg'}`] = texture.bytes;
    n.mesh = { material: { definition: textured ? 0 : 1, ...(textured ? { resource: r, texelCountHint: texels } : {}) }, geometry: { definition: 0, resource: r, vertexCount: nv, featureCount: ids.length }, attribute: { resource: r } };
    n.features = ids;
    onProgress?.((li + 1) / leaves.length);
  });
  // Inner nodes' OBBs enclose their children's vertices.
  const geoOf = (n) => (n.leaf != null ? [leafGeo.get(n.leaf)] : n.children.flatMap((c) => geoOf(nodes[c])));
  for (const n of nodes)
    if (n.leaf == null) {
      const parts = geoOf(n);
      const tot = parts.reduce((s, g) => s + g.length, 0);
      const all = new Float64Array(tot);
      let o = 0;
      for (const g of parts) {
        all.set(g, o);
        o += g.length;
      }
      n.obb = obbOf(all);
    }
  // LOD: a node is replaced by its children once its bounding sphere covers more than about a
  // 512-pixel disc; leaves keep the same rule (they have no children).
  const lod = Math.PI * 256 * 256;
  const nodePageNodes = nodes.map((n) => ({
    index: n.index,
    ...(n.parentIndex != null ? { parentIndex: n.parentIndex } : {}),
    ...(n.index ? { lodThreshold: lod } : {}),
    obb: n.obb,
    ...(n.children.length ? { children: n.children } : {}),
    ...(n.mesh ? { mesh: n.mesh } : {}),
  }));
  for (let p = 0; p * nodesPerPage < nodes.length; p++) files[`nodepages/${p}.json.gz`] = jgz({ nodes: nodePageNodes.slice(p * nodesPerPage, (p + 1) * nodesPerPage) });
  // 1.6 node index documents and shared resources (older clients, and i3s_converter's 1.6 checks).
  const id16 = (n) => (n.index === 0 ? 'root' : String(n.index));
  const mbs = (o) => [...o.center, Math.hypot(...o.halfSize)];
  const ref = (n) => ({ id: id16(n), href: `../${id16(n)}`, mbs: mbs(n.obb), obb: n.obb });
  for (const n of nodes) {
    const doc = {
      id: id16(n),
      level: n.index === 0 ? 0 : (n.level ?? 1),
      mbs: mbs(n.obb),
      obb: n.obb,
      lodSelection: [
        { metricType: 'maxScreenThresholdSQ', maxError: n.index ? lod : 0 },
        { metricType: 'maxScreenThreshold', maxError: n.index ? Math.sqrt(lod / (Math.PI * 0.25)) : 0 },
      ],
      ...(n.children.length ? { children: n.children.map((c) => ref(nodes[c])) } : {}),
      ...(n.parentIndex != null ? { parentNode: ref(nodes[n.parentIndex]) } : {}),
    };
    if (n.mesh) {
      doc.featureData = [{ href: './features/0' }];
      doc.geometryData = [{ href: './geometries/0' }];
      if (n.mesh.material.resource != null) doc.textureData = [{ href: './textures/0' }];
      doc.sharedResource = { href: './shared' };
      doc.attributeData = storage.map((s) => ({ href: `./attributes/${s.key}/0` }));
      files[`nodes/${n.index}/features/0.json.gz`] = jgz({ featureData: [], geometryData: [] });
      const tex = n.mesh.material.resource != null;
      files[`nodes/${n.index}/shared/sharedResource.json.gz`] = jgz({
        materialDefinitions: { 0: { type: 'standard', name: 'standard', params: { vertexRegions: false, vertexColors: true, useVertexColorAlpha: false, reflectivity: 0, shininess: 1, ambient: [0, 0, 0], diffuse: tex ? [1, 1, 1] : colour, specular: [0.1, 0.1, 0.1], renderMode: tex ? 'textured' : 'solid', cullFace: 'none' } } },
        ...(tex ? { textureDefinitions: { '0': { encoding: [texture.format === 'png' ? 'image/png' : 'image/jpeg'], wrap: ['none'], atlas: false, uvSet: 'uv0', channels: 'rgb', images: [{ id: '0', size: 0, href: ['./textures/0'] }] } } } : {}),
      });
    }
    files[`nodes/${id16(n)}/3dNodeIndexDocument.json.gz`] = jgz(doc);
  }
  // Extent.
  let [x0, y0, z0, x1, y1, z1] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const g of geos)
    for (let i = 0; i < g.length; i += 3) {
      x0 = Math.min(x0, g[i]);
      x1 = Math.max(x1, g[i]);
      y0 = Math.min(y0, g[i + 1]);
      y1 = Math.max(y1, g[i + 1]);
      z0 = Math.min(z0, g[i + 2]);
      z1 = Math.max(z1, g[i + 2]);
    }
  const sr = { wkid: 4326, latestWkid: 4326, vcsWkid: 115700, latestVcsWkid: 115700 };
  const layer = {
    id: 0,
    version: guid(),
    name,
    alias: name,
    layerType: '3DObject',
    description: 'GIS Workbench',
    capabilities: ['View', 'Query'],
    spatialReference: sr,
    heightModelInfo: { heightModel: 'ellipsoidal', vertCRS: 'WGS_84', heightUnit: 'meter' },
    fullExtent: { xmin: x0, ymin: y0, xmax: x1, ymax: y1, zmin: z0, zmax: z1, spatialReference: sr },
    store: {
      id: guid(),
      profile: 'meshpyramids',
      version: '1.8',
      resourcePattern: ['3dNodeIndexDocument', 'SharedResource', 'Geometry', 'Attributes'],
      rootNode: './nodes/root',
      extent: [x0, y0, x1, y1],
      indexCRS: 'http://www.opengis.net/def/crs/EPSG/0/4326',
      vertexCRS: 'http://www.opengis.net/def/crs/EPSG/0/4326',
      normalReferenceFrame: 'east-north-up',
      lodType: 'MeshPyramid',
      lodModel: 'node-switching',
      ...(texture ? { textureEncoding: [texture.format === 'png' ? 'image/png' : 'image/jpeg'] } : {}),
      defaultGeometrySchema: {
        geometryType: 'triangles',
        header: [
          { property: 'vertexCount', type: 'UInt32' },
          { property: 'featureCount', type: 'UInt32' },
        ],
        topology: 'PerAttributeArray',
        ordering: ['position', 'normal', 'uv0', 'color'],
        vertexAttributes: { position: { valueType: 'Float32', valuesPerElement: 3 }, normal: { valueType: 'Float32', valuesPerElement: 3 }, uv0: { valueType: 'Float32', valuesPerElement: 2 }, color: { valueType: 'UInt8', valuesPerElement: 4 } },
        featureAttributeOrder: ['id', 'faceRange'],
        featureAttributes: { id: { valueType: 'UInt64', valuesPerElement: 1 }, faceRange: { valueType: 'UInt32', valuesPerElement: 2 } },
      },
    },
    fields: fields.map(({ name: n, type, alias }) => ({ name: n, type, alias })),
    attributeStorageInfo: storage,
    nodePages: { nodesPerPage, lodSelectionMetricType: 'maxScreenThresholdSQ', rootIndex: 0 },
    materialDefinitions: [
      { doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { textureSetDefinitionId: 0 }, metallicFactor: 0 } },
      { doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [...colour, 1], metallicFactor: 0 } },
    ],
    ...(texture ? { textureSetDefinitions: [{ formats: [{ name: '0', format: texture.format === 'png' ? 'png' : 'jpg' }] }] } : {}),
    geometryDefinitions: [
      {
        geometryBuffers: [
          {
            offset: 8,
            position: { type: 'Float32', component: 3 },
            normal: { type: 'Float32', component: 3 },
            uv0: { type: 'Float32', component: 2 },
            color: { type: 'UInt8', component: 4 },
            featureId: { type: 'UInt64', component: 1, binding: 'per-feature' },
            faceRange: { type: 'UInt32', component: 2, binding: 'per-feature' },
          },
        ],
      },
    ],
  };
  // Statistics of every field but the object id (clients build their filters and legends from them).
  layer.statisticsInfo = [];
  storage.forEach((s, k) => {
    if (k === 0) return;
    const vals = objects.map((o, i) => fields[k].get(o, i));
    let stats;
    if (fields[k].vt === 'Float64') {
      const v = vals.map(Number).filter(Number.isFinite);
      const sum = v.reduce((a, b) => a + b, 0);
      const avg = v.length ? sum / v.length : 0;
      const variance = v.length ? v.reduce((a, b) => a + (b - avg) ** 2, 0) / v.length : 0;
      stats = { totalValuesCount: vals.length, count: v.length, min: v.length ? Math.min(...v) : 0, max: v.length ? Math.max(...v) : 0, sum, avg, variance, stddev: Math.sqrt(variance) };
    } else {
      const counts = new Map();
      for (const x of vals) counts.set(x, (counts.get(x) ?? 0) + 1);
      stats = { totalValuesCount: vals.length, mostFrequentValues: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([value, count]) => ({ value, count })) };
    }
    files[`statistics/${s.key}/0.json.gz`] = jgz({ stats });
    layer.statisticsInfo.push({ key: s.key, name: s.name, href: `./statistics/${s.key}/0` });
  });
  files['3dSceneLayer.json.gz'] = jgz(layer);
  files['metadata.json'] = te.encode(JSON.stringify({ I3SVersion: '1.8', nodeCount: nodes.length }, null, 2));
  return { bytes: zipHashed(files), nodes: nodes.length, leaves: leaves.length, vertices, features: objects.length, layer };
}

/** A STORE ZIP of `files` with the SLPK MD5 hash index as its last entry (I3S slpk_hashtable). */
export function zipHashed(files) {
  const names = Object.keys(files);
  const ordered = Object.fromEntries(names.map((k) => [k, [files[k], { level: 0 }]]));
  const zip = zipSync(ordered);
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const offsets = [];
  let o = 0;
  for (let i = 0; i < names.length; i++) {
    if (dv.getUint32(o, true) !== 0x04034b50) throw new Error('slpk: unexpected ZIP layout');
    offsets.push(o);
    o += 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true) + dv.getUint32(o + 18, true);
  }
  if (o > 0xfffffff0) throw new Error('slpk: the package passes 4 GB, which this writer does not write');
  const idx = names.map((n, i) => ({ h: md5(te.encode(n.replace(/^\/+/, '').toLowerCase())), off: offsets[i] }));
  const key = (h) => {
    const d = new DataView(h.buffer, h.byteOffset, 16);
    return [d.getBigUint64(0, true), d.getBigUint64(8, true)];
  };
  idx.sort((a, b) => {
    const [ah, al] = key(a.h);
    const [bh, bl] = key(b.h);
    return ah < bh ? -1 : ah > bh ? 1 : al < bl ? -1 : al > bl ? 1 : 0;
  });
  const index = new Uint8Array(24 * idx.length);
  const iv = new DataView(index.buffer);
  idx.forEach((e, i) => {
    index.set(e.h, 24 * i);
    iv.setBigUint64(24 * i + 16, BigInt(e.off), true);
  });
  return zipSync({ ...ordered, '@specialIndexFileHASH128@': [index, { level: 0 }] });
}
