// glTF 1.0 → 2.0 (legacy 3D Tiles content, REQ-FMT-36): b3dm and i3dm tiles written before 2017
// embed binary glTF 1.0 (KHR_binary_glTF), which three.js's GLTFLoader does not read. This turns
// such a model into a GLB 2.0 the loader takes: dictionaries become arrays, accessor strides move
// to their own buffer views, the binary body becomes the BIN chunk, materials become metallic-
// roughness with the 1.0 diffuse colour or texture (KHR_materials_common or technique values),
// BATCHID becomes _BATCHID and CESIUM_RTC's centre is returned for the caller to apply.
// Every offset and length is checked against the body.

const td = new TextDecoder();
const te = new TextEncoder();

export const isGltf1 = (b) => b.length >= 20 && b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46 && new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4, true) === 1;

const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
import { gwError } from '../i18n/index.js';

const CBYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** Binary glTF 1.0 bytes → {glb (2.0), rtc: [x, y, z] | null}. */
export function upgradeGltf1(b) {
  const bad = (m) => {
    throw gwError('glTF 1.0 content: {msg}', { msg: m }, 'E_GLTF1');
  };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const length = Math.min(dv.getUint32(8, true), b.length);
  const contentLength = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0) bad('the content is not JSON');
  if (20 + contentLength > length) bad('the JSON runs past the file');
  let j;
  try {
    j = JSON.parse(td.decode(b.subarray(20, 20 + contentLength)));
  } catch {
    bad('the JSON is malformed');
  }
  const body = b.subarray(20 + contentLength, length);
  const ids = (o) => Object.keys(o ?? {});
  const index = (o) => new Map(ids(o).map((k, i) => [k, i]));
  // Buffers: the binary body, or data: URIs (others are not reachable from a tile).
  const bufData = new Map();
  for (const [k, v] of Object.entries(j.buffers ?? {})) {
    if (k === 'binary_glTF' || v.extensions?.KHR_binary_glTF || v.uri === 'data:,') bufData.set(k, body);
    else if (/^data:[^,]*;base64,/.test(v.uri ?? '')) bufData.set(k, Uint8Array.from(atob(v.uri.slice(v.uri.indexOf(',') + 1)), (c) => c.charCodeAt(0)));
    else bad(`buffer ${k} is external (${v.uri})`);
  }
  const chunks = [];
  let binLen = 0;
  const addView = (bytes, extra = {}) => {
    const off = binLen;
    chunks.push(bytes);
    binLen += bytes.length + ((4 - (bytes.length % 4)) % 4);
    views.push({ buffer: 0, byteOffset: off, byteLength: bytes.length, ...extra });
    return views.length - 1;
  };
  const views = [];
  const viewBytes = (id) => {
    const v = j.bufferViews?.[id];
    if (!v) bad(`buffer view ${id} is missing`);
    const data = bufData.get(v.buffer);
    if (!data) bad(`buffer ${v.buffer} is missing`);
    const off = v.byteOffset ?? 0;
    const len = v.byteLength ?? data.length - off;
    if (off < 0 || off + len > data.length) bad(`buffer view ${id} runs past its buffer`);
    return { bytes: data.subarray(off, off + len), target: v.target };
  };
  const accIdx = index(j.accessors);
  const accessors = ids(j.accessors).map((k) => {
    const a = j.accessors[k];
    const { bytes, target } = viewBytes(a.bufferView);
    const elem = SIZE[a.type] * (CBYTES[a.componentType] ?? bad(`accessor ${k} has component type ${a.componentType}`));
    const stride = a.byteStride && a.byteStride !== elem ? a.byteStride : 0;
    const off = a.byteOffset ?? 0;
    const len = a.count ? (stride || elem) * (a.count - 1) + elem : 0;
    if (off + len > bytes.length) bad(`accessor ${k} runs past its buffer view`);
    const view = addView(bytes.slice(off, off + len), { ...(stride ? { byteStride: stride } : {}), ...(target ? { target } : {}) });
    const out = { bufferView: view, componentType: a.componentType, count: a.count, type: a.type };
    if (a.min) out.min = a.min;
    if (a.max) out.max = a.max;
    return out;
  });
  // Images and textures.
  const imgIdx = index(j.images);
  const images = ids(j.images).map((k) => {
    const im = j.images[k];
    const ext = im.extensions?.KHR_binary_glTF;
    if (ext) return { bufferView: addView(viewBytes(ext.bufferView).bytes.slice()), mimeType: ext.mimeType ?? 'image/png' };
    if (/^data:/.test(im.uri ?? '')) return { uri: im.uri };
    return { uri: im.uri };
  });
  const smpIdx = index(j.samplers);
  const samplers = ids(j.samplers).map((k) => {
    const s = j.samplers[k];
    return Object.fromEntries(['magFilter', 'minFilter', 'wrapS', 'wrapT'].filter((p) => s[p] !== undefined).map((p) => [p, s[p]]));
  });
  const texIdx = index(j.textures);
  const textures = ids(j.textures).map((k) => {
    const t = j.textures[k];
    return { ...(imgIdx.has(t.source) ? { source: imgIdx.get(t.source) } : {}), ...(smpIdx.has(t.sampler) ? { sampler: smpIdx.get(t.sampler) } : {}) };
  });
  const matIdx = index(j.materials);
  const materials = ids(j.materials).map((k) => {
    const m = j.materials[k];
    const v = m.extensions?.KHR_materials_common?.values ?? m.values ?? {};
    const d = v.diffuse ?? v.u_diffuse ?? v.ambient;
    const pbr = { metallicFactor: 0, roughnessFactor: 1 };
    const tex = Array.isArray(d) ? d[0] : d; // a texture is named alone or as the array's first item (#37)
    if (typeof tex === 'string') {
      if (texIdx.has(tex)) pbr.baseColorTexture = { index: texIdx.get(tex) };
    } else if (Array.isArray(d)) pbr.baseColorFactor = [d[0] ?? 1, d[1] ?? 1, d[2] ?? 1, d[3] ?? 1];
    return { name: m.name ?? k, pbrMetallicRoughness: pbr, doubleSided: !!(m.extensions?.KHR_materials_common?.doubleSided ?? v.doubleSided) };
  });
  const meshIdx = index(j.meshes);
  const meshes = ids(j.meshes).map((k) => ({
    primitives: (j.meshes[k].primitives ?? []).map((p) => {
      const attributes = {};
      for (const [sem, acc] of Object.entries(p.attributes ?? {})) {
        if (!accIdx.has(acc)) continue;
        const name = /^(POSITION|NORMAL|TANGENT|TEXCOORD_\d+|COLOR_\d+|JOINTS_\d+|WEIGHTS_\d+)$/.test(sem) ? sem : sem === 'TEXCOORD' ? 'TEXCOORD_0' : sem === 'COLOR' ? 'COLOR_0' : `_${sem}`;
        attributes[name] = accIdx.get(acc);
      }
      return { attributes, ...(accIdx.has(p.indices) ? { indices: accIdx.get(p.indices) } : {}), ...(matIdx.has(p.material) ? { material: matIdx.get(p.material) } : {}), mode: p.mode ?? p.primitive ?? 4 };
    }),
  }));
  // Nodes: a 1.0 node may list several meshes; each becomes a child node.
  const nodeIds = ids(j.nodes);
  const nodeIdx = new Map(nodeIds.map((k, i) => [k, i]));
  const nodes = nodeIds.map((k) => {
    const n = j.nodes[k];
    const o = {};
    for (const p of ['matrix', 'translation', 'rotation', 'scale']) if (n[p]) o[p] = n[p];
    const kids = (n.children ?? []).filter((c) => nodeIdx.has(c)).map((c) => nodeIdx.get(c));
    const ms = (n.meshes ?? []).filter((m) => meshIdx.has(m)).map((m) => meshIdx.get(m));
    if (ms.length === 1) o.mesh = ms[0];
    o.__extra = ms.length > 1 ? ms : [];
    if (kids.length) o.children = kids;
    return o;
  });
  for (const n of [...nodes]) {
    for (const m of n.__extra) {
      nodes.push({ mesh: m });
      (n.children ??= []).push(nodes.length - 1);
    }
    delete n.__extra;
  }
  const sceneIds = ids(j.scenes);
  const scenes = sceneIds.map((k) => ({ nodes: (j.scenes[k].nodes ?? []).filter((x) => nodeIdx.has(x)).map((x) => nodeIdx.get(x)) }));
  if (!scenes.length) scenes.push({ nodes: nodes.map((_, i) => i).filter((i) => !nodes.some((n) => n.children?.includes(i))) });
  const json = {
    asset: { version: '2.0', generator: 'GIS Workbench (from glTF 1.0)' },
    scene: Math.max(0, sceneIds.indexOf(j.scene)),
    scenes,
    nodes,
    meshes,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: binLen }],
    ...(materials.length ? { materials } : {}),
    ...(textures.length ? { textures } : {}),
    ...(images.length ? { images } : {}),
    ...(samplers.length ? { samplers } : {}),
  };
  const bin = new Uint8Array(binLen);
  let o = 0;
  for (const c of chunks) {
    bin.set(c, o);
    o += c.length + ((4 - (c.length % 4)) % 4);
  }
  const jb = te.encode(JSON.stringify(json));
  const jl = jb.length + ((4 - (jb.length % 4)) % 4);
  const out = new Uint8Array(12 + 8 + jl + 8 + bin.length);
  const w = new DataView(out.buffer);
  w.setUint32(0, 0x46546c67, true);
  w.setUint32(4, 2, true);
  w.setUint32(8, out.length, true);
  w.setUint32(12, jl, true);
  w.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jl);
  out.set(jb, 20);
  w.setUint32(20 + jl, bin.length, true);
  w.setUint32(24 + jl, 0x004e4942, true);
  out.set(bin, 28 + jl);
  const rtc = j.extensions?.CESIUM_RTC?.center ?? null;
  return { glb: out, rtc: Array.isArray(rtc) && rtc.length >= 3 ? rtc.slice(0, 3) : null };
}
