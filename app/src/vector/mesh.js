// 3D building models (REQ-EXT-14) and their export (REQ-EXT-25): LOD1 extrusion of a footprint
// from its base to its height, and gable, hip and shed roofs on four-cornered footprints (other
// outlines keep a flat roof, said in the model note). Faces carry CityGML semantics (ground,
// wall, roof). Writers: glTF 2.0 / GLB (local ENU about an origin, Y up, attributes as extras),
// Wavefront OBJ, and CityJSON 2.0 (LOD 1 solids, LOD 2 with roof surfaces) in a projected CRS.

/** Ear-clipping triangulation of a simple 2D polygon; returns index triples. */
export function triangulate(pts) {
  const n = pts.length;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const idx = Array.from({ length: n }, (_, i) => i);
  if (area < 0) idx.reverse();
  const out = [];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inTri = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const [a, b, c] = [pts[ia], pts[ib], pts[ic]];
      if (cross(a, b, c) <= 1e-12) continue;
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(pts[j], a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push([ia, ib, ic]);
      idx.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) break; // degenerate: give up on the rest
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

const ringArea = (r) => {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i][0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * r[i][1];
  return s / 2;
};

/**
 * Model one building in local metres. `ring` = footprint [[x, y], …] (open), `base` = ground
 * height, `height` = eave height above the base, `roof` = 'flat' | 'gable' | 'hip' | 'shed' with
 * `ridge` m above the eaves. Returns {vertices: [[x, y, z]…], faces: [{type, idx: [...]}],
 * roof, note}.
 */
export function buildingModel({ ring, base, height, roof = 'flat', ridge = 0 }) {
  let r = ring.slice();
  if (ringArea(r) < 0) r.reverse(); // counter-clockwise from above
  const V = [];
  const F = [];
  const add = (x, y, z) => V.push([x, y, z]) - 1;
  const top = base + height;
  let kind = roof;
  let note = '';
  if (kind !== 'flat' && (r.length !== 4 || !(ridge > 0))) {
    note = r.length !== 4 ? `${roof} roofs need a four-cornered footprint; modelled flat` : 'no ridge height; modelled flat';
    kind = 'flat';
  }
  const g = r.map(([x, y]) => add(x, y, base));
  F.push({ type: 'GroundSurface', idx: g.slice().reverse() });
  if (kind === 'flat') {
    const t = r.map(([x, y]) => add(x, y, top));
    for (let i = 0; i < r.length; i++) {
      const j = (i + 1) % r.length;
      F.push({ type: 'WallSurface', idx: [g[i], g[j], t[j], t[i]] });
    }
    F.push({ type: 'RoofSurface', idx: t });
    return { vertices: V, faces: F, roof: 'flat', note };
  }
  // Rectangle-like footprint: the long axis runs along edge 0–1 if it is the longer one.
  const L = (a, b) => Math.hypot(r[b][0] - r[a][0], r[b][1] - r[a][1]);
  const s = L(0, 1) >= L(1, 2) ? 0 : 1; // first vertex of a long edge
  const q = [0, 1, 2, 3].map((k) => r[(k + s) % 4]); // q0–q1 long, q1–q2 short
  const e = q.map(([x, y]) => add(x, y, top)); // eave corners
  const gq = [0, 1, 2, 3].map((k) => g[(k + s) % 4]);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const zr = top + ridge;
  if (kind === 'gable' || kind === 'hip') {
    // Ridge along the long axis, through the middles of the short edges (hip: inset by half the width).
    let m1 = mid(q[1], q[2]);
    let m0 = mid(q[3], q[0]);
    if (kind === 'hip') {
      const w = L((1 + s) % 4, (2 + s) % 4) / 2;
      const len = Math.hypot(m1[0] - m0[0], m1[1] - m0[1]);
      const u = [(m1[0] - m0[0]) / len, (m1[1] - m0[1]) / len];
      const inset = Math.min(w, len / 2 - 0.01);
      m0 = [m0[0] + u[0] * inset, m0[1] + u[1] * inset];
      m1 = [m1[0] - u[0] * inset, m1[1] - u[1] * inset];
    }
    const r0 = add(m0[0], m0[1], zr);
    const r1 = add(m1[0], m1[1], zr);
    // Walls to the eaves on all sides; gable ends rise to the ridge.
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      if (kind === 'gable' && (k === 1 || k === 3)) {
        const rr = k === 1 ? r1 : r0;
        F.push({ type: 'WallSurface', idx: [gq[k], gq[j], e[j], rr, e[k]] });
      } else F.push({ type: 'WallSurface', idx: [gq[k], gq[j], e[j], e[k]] });
    }
    F.push({ type: 'RoofSurface', idx: [e[0], e[1], r1, r0] });
    F.push({ type: 'RoofSurface', idx: [e[2], e[3], r0, r1] });
    if (kind === 'hip') {
      F.push({ type: 'RoofSurface', idx: [e[1], e[2], r1] });
      F.push({ type: 'RoofSurface', idx: [e[3], e[0], r0] });
    }
    return { vertices: V, faces: F, roof: kind, note };
  }
  // Shed: eaves on edge q0–q1, the opposite edge q2–q3 at the ridge height.
  const h2 = q.slice(2).map(([x, y]) => add(x, y, zr));
  const hi = [e[0], e[1], h2[0], h2[1]];
  F.push({ type: 'WallSurface', idx: [gq[0], gq[1], hi[1], hi[0]] });
  F.push({ type: 'WallSurface', idx: [gq[1], gq[2], hi[2], hi[1]] });
  F.push({ type: 'WallSurface', idx: [gq[2], gq[3], hi[3], hi[2]] });
  F.push({ type: 'WallSurface', idx: [gq[3], gq[0], hi[0], hi[3]] });
  F.push({ type: 'RoofSurface', idx: [hi[0], hi[1], hi[2], hi[3]] });
  return { vertices: V, faces: F, roof: 'shed', note };
}

/** Newell normal of a face. */
function normal(V, idx) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < idx.length; i++) {
    const a = V[idx[i]];
    const b = V[idx[(i + 1) % idx.length]];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Triangles of a planar 3D face (projected on its dominant plane). */
export function faceTriangles(V, idx) {
  const n = normal(V, idx);
  const ax = Math.abs(n[0]) > Math.abs(n[1]) && Math.abs(n[0]) > Math.abs(n[2]) ? 0 : Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2;
  const [u, v] = ax === 0 ? [1, 2] : ax === 1 ? [2, 0] : [0, 1];
  const flip = n[ax] < 0;
  const pts = idx.map((i) => (flip ? [V[i][v], V[i][u]] : [V[i][u], V[i][v]]));
  return triangulate(pts).map(([a, b, c]) => [idx[a], idx[b], idx[c]]);
}

const pad4 = (n) => (4 - (n % 4)) % 4;

/**
 * glTF 2.0 / GLB of building models. `models` = [{id, name, model (local ENU, z up), attrs}];
 * `origin` = {lat, lon, h}. `texture` = {png (bytes), uv(x, y, z) → [u, v]} textures every face
 * from one image (REQ-EXT-15). Returns Uint8Array (GLB) or the JSON text (gltf, buffer embedded).
 */
export function writeGltf(models, origin, { glb = true, generator = 'GIS Workbench', texture = null } = {}) {
  const pos = [];
  const nrm = [];
  const ind = [];
  const uvs = [];
  const prims = [];
  for (const m of models) {
    const V = m.model.vertices;
    const start = pos.length / 3;
    const iStart = ind.length;
    let k = start;
    for (const f of m.model.faces) {
      const n = normal(V, f.idx);
      for (const tri of faceTriangles(V, f.idx)) {
        for (const vi of tri) {
          const [x, y, z] = V[vi];
          pos.push(x, z, -y); // ENU (z up) → glTF (y up, −z north)
          nrm.push(n[0], n[2], -n[1]);
          if (texture) uvs.push(...texture.uv(x, y, z));
          ind.push(k++);
        }
      }
    }
    prims.push({ m, vStart: start, vCount: pos.length / 3 - start, iStart, iCount: ind.length - iStart });
  }
  const nV = pos.length / 3;
  const P = new Float32Array(pos);
  const N = new Float32Array(nrm);
  const I = nV < 65536 ? new Uint16Array(ind) : new Uint32Array(ind);
  const UV = texture ? new Float32Array(uvs) : null;
  const uvAt = P.byteLength + N.byteLength + I.byteLength + pad4(I.byteLength);
  const imgAt = uvAt + (UV ? UV.byteLength : 0);
  const binLen = imgAt + (texture ? texture.png.length + pad4(texture.png.length) : 0);
  const bin = new Uint8Array(binLen);
  bin.set(new Uint8Array(P.buffer), 0);
  bin.set(new Uint8Array(N.buffer), P.byteLength);
  bin.set(new Uint8Array(I.buffer), P.byteLength + N.byteLength);
  if (UV) bin.set(new Uint8Array(UV.buffer), uvAt);
  if (texture) bin.set(texture.png, imgAt);
  const accessors = [];
  const meshes = [];
  const nodes = [];
  const iBytes = I.BYTES_PER_ELEMENT;
  for (const pr of prims) {
    let mn = [Infinity, Infinity, Infinity];
    let mx = [-Infinity, -Infinity, -Infinity];
    for (let v = pr.vStart; v < pr.vStart + pr.vCount; v++)
      for (let a = 0; a < 3; a++) {
        mn[a] = Math.min(mn[a], P[3 * v + a]);
        mx[a] = Math.max(mx[a], P[3 * v + a]);
      }
    if (!pr.vCount) {
      mn = [0, 0, 0];
      mx = [0, 0, 0];
    }
    const a0 = accessors.length;
    accessors.push({ bufferView: 0, byteOffset: pr.vStart * 12, componentType: 5126, count: pr.vCount, type: 'VEC3', min: mn, max: mx });
    accessors.push({ bufferView: 1, byteOffset: pr.vStart * 12, componentType: 5126, count: pr.vCount, type: 'VEC3' });
    // Indices are per model: rebase to the model's first vertex.
    accessors.push({ bufferView: 2, byteOffset: pr.iStart * iBytes, componentType: iBytes === 2 ? 5123 : 5125, count: pr.iCount, type: 'SCALAR' });
    const attributes = { POSITION: a0, NORMAL: a0 + 1 };
    if (UV) {
      attributes.TEXCOORD_0 = accessors.length;
      accessors.push({ bufferView: 3, byteOffset: pr.vStart * 8, componentType: 5126, count: pr.vCount, type: 'VEC2' });
    }
    meshes.push({ name: pr.m.name ?? pr.m.id, primitives: [{ attributes, indices: a0 + 2, material: 0, mode: 4 }] });
    nodes.push({ name: pr.m.name ?? pr.m.id, mesh: meshes.length - 1, extras: { id: pr.m.id, roof: pr.m.model.roof, ...(pr.m.attrs ?? {}) } });
  }
  // Index values must be relative to each accessor's vertices: rewrite in place.
  for (const pr of prims) for (let i = pr.iStart; i < pr.iStart + pr.iCount; i++) I[i] -= pr.vStart;
  bin.set(new Uint8Array(I.buffer), P.byteLength + N.byteLength);
  const json = {
    asset: { version: '2.0', generator, extras: { origin, frame: 'local ENU at the origin: glTF x east, y up, −z north; metres; heights above the WGS 84 ellipsoid minus origin.h' } },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials: [texture ? { name: 'building (textured)', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true } : { name: 'building', pbrMetallicRoughness: { baseColorFactor: [0.82, 0.78, 0.72, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: false }],
    accessors,
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: P.byteLength, target: 34962 },
      { buffer: 0, byteOffset: P.byteLength, byteLength: N.byteLength, target: 34962 },
      { buffer: 0, byteOffset: P.byteLength + N.byteLength, byteLength: I.byteLength, target: 34963 },
      ...(UV ? [{ buffer: 0, byteOffset: uvAt, byteLength: UV.byteLength, target: 34962 }, { buffer: 0, byteOffset: imgAt, byteLength: texture.png.length }] : []),
    ],
    ...(texture ? { images: [{ bufferView: 4, mimeType: 'image/png', name: texture.name ?? 'texture' }], samplers: [{ magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 }], textures: [{ source: 0, sampler: 0 }] } : {}),
    buffers: [{ byteLength: binLen }],
  };
  if (!glb) {
    let s = '';
    for (let i = 0; i < bin.length; i += 0x8000) s += String.fromCharCode(...bin.subarray(i, i + 0x8000));
    json.buffers[0].uri = `data:application/octet-stream;base64,${btoa(s)}`;
    return JSON.stringify(json);
  }
  const jt = new TextEncoder().encode(JSON.stringify(json));
  const jl = jt.length + pad4(jt.length);
  const total = 12 + 8 + jl + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jl, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jt, 20);
  out.fill(0x20, 20 + jt.length, 20 + jl);
  dv.setUint32(20 + jl, binLen, true);
  dv.setUint32(24 + jl, 0x004e4942, true); // 'BIN\0'
  out.set(bin, 28 + jl);
  return out;
}

/** Wavefront OBJ (local ENU, z up, metres). */
export function writeObj(models, origin) {
  const lines = [`# GIS Workbench buildings; local ENU metres (x east, y north, z up) about lat ${origin.lat}, lon ${origin.lon}, h ${origin.h} m HAE`];
  let base = 1;
  for (const m of models) {
    lines.push(`o ${String(m.name ?? m.id).replace(/\s+/g, '_')}`);
    for (const v of m.model.vertices) lines.push(`v ${v[0].toFixed(3)} ${v[1].toFixed(3)} ${v[2].toFixed(3)}`);
    for (const f of m.model.faces) lines.push(`f ${f.idx.map((i) => i + base).join(' ')}`);
    base += m.model.vertices.length;
  }
  return `${lines.join('\n')}\n`;
}

/**
 * CityJSON 2.0. `project(lon, lat)` → [x, y] in `crsUri`; local model vertices are converted with
 * `toGeo(x, y) → [lon, lat]` and heights stay HAE (z + origin.h).
 */
export function writeCityJson(models, { toGeo, project, crsUri, origin, title = 'GIS Workbench buildings' }) {
  const verts = [];
  const map = new Map();
  const vid = (x, y, z) => {
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    if (!map.has(key)) {
      map.set(key, verts.length);
      verts.push([x, y, z]);
    }
    return map.get(key);
  };
  const objects = {};
  for (const m of models) {
    const V = m.model.vertices.map(([x, y, z]) => {
      const [lon, lat] = toGeo(x, y);
      const [X, Y] = project(lon, lat);
      return vid(X, Y, z + origin.h);
    });
    const semTypes = ['GroundSurface', 'WallSurface', 'RoofSurface'];
    const lod = m.model.roof === 'flat' ? '1.2' : '2.2';
    const shell = m.model.faces.map((f) => [f.idx.map((i) => V[i])]);
    const values = m.model.faces.map((f) => semTypes.indexOf(f.type));
    objects[m.id] = {
      type: 'Building',
      attributes: { ...(m.attrs ?? {}), roofType: m.model.roof, ...(m.height !== undefined ? { measuredHeight: m.height } : {}) },
      geometry: [{ type: 'Solid', lod, boundaries: [shell], semantics: { surfaces: semTypes.map((type) => ({ type })), values: [values] } }],
    };
  }
  // Quantise to millimetres.
  const mn = [0, 1, 2].map((a) => Math.min(...verts.map((v) => v[a])));
  const scale = [0.001, 0.001, 0.001];
  const vertices = verts.map((v) => v.map((x, a) => Math.round((x - mn[a]) / scale[a])));
  return JSON.stringify({ type: 'CityJSON', version: '2.0', transform: { scale, translate: mn }, metadata: { title, referenceSystem: crsUri, geographicalExtent: [...mn, ...[0, 1, 2].map((a) => Math.max(...verts.map((v) => v[a])))] }, CityObjects: objects, vertices });
}
