// Draco geometry and KTX2 / Basis Universal textures for glTF export (REQ-FMT-35, FC-08, FC-09):
// a GLB (as the app's writers produce it: one binary buffer, non-interleaved float32 attributes,
// u16/u32 indices, PNG/JPEG images) is rewritten with KHR_draco_mesh_compression primitives
// and KHR_texture_basisu textures. The encoders come from the hash-checked codec pack
// (`codec-3d`: Google's Draco encoder and Binomial's Basis Universal encoder, Apache-2.0, via
// draco3d and ktx2-encoder) and are never part of the HTML. Pure: the encoders are passed in, so
// the FX-21 generator (Node) and the app (pack) share this code.

const te = new TextEncoder();
const td = new TextDecoder();
const pad4 = (n) => (4 - (n % 4)) % 4;

/** GLB → {json, bin}. */
export function readGlb(glb) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  let o = 12;
  let json = null;
  let bin = new Uint8Array(0);
  while (o + 8 <= glb.length) {
    const len = dv.getUint32(o, true);
    const type = dv.getUint32(o + 4, true);
    const body = glb.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(td.decode(body));
    else if (type === 0x004e4942) bin = body;
    o += 8 + len;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

/** {json, bin} → GLB. */
export function writeGlb(json, bin) {
  const j = te.encode(JSON.stringify(json));
  const jl = j.length + pad4(j.length);
  const bl = bin.length + pad4(bin.length);
  const out = new Uint8Array(12 + 8 + jl + (bl ? 8 + bl : 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jl, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jl);
  out.set(j, 20);
  if (bl) {
    dv.setUint32(20 + jl, bl, true);
    dv.setUint32(24 + jl, 0x004e4942, true);
    out.set(bin, 28 + jl);
  }
  return out;
}

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function accessorData(json, bin, i) {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  if (bv.byteStride && bv.byteStride !== SIZE[a.type] * COMP[a.componentType].BYTES_PER_ELEMENT) throw new Error('interleaved attributes are not compressed');
  const T = COMP[a.componentType];
  const off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const n = a.count * SIZE[a.type];
  return new T(bin.slice(off, off + n * T.BYTES_PER_ELEMENT).buffer, 0, n);
}

/** Draco-encode one triangle primitive with the Draco encoder module `M`: {bytes, attributes}. */
export function dracoEncode(M, { indices, attrs }, { sequential = true, quant = { POSITION: 14, NORMAL: 10, TEXCOORD_0: 12, COLOR_0: 8 } } = {}) {
  const encoder = new M.Encoder();
  const builder = new M.MeshBuilder();
  const mesh = new M.Mesh();
  const ids = {};
  const DT = { POSITION: M.POSITION, NORMAL: M.NORMAL, TEXCOORD_0: M.TEX_COORD, COLOR_0: M.COLOR };
  try {
    const nFaces = indices.length / 3;
    builder.AddFacesToMesh(mesh, nFaces, indices instanceof Uint32Array ? indices : Uint32Array.from(indices));
    for (const [name, { data, size, count }] of Object.entries(attrs)) {
      const kind = DT[name] ?? M.GENERIC;
      ids[name] = data instanceof Float32Array ? builder.AddFloatAttributeToMesh(mesh, kind, count, size, data) : builder.AddUInt8AttributeToMesh?.(mesh, kind, count, size, data);
      if (quant[name] !== undefined) encoder.SetAttributeQuantization(kind, quant[name]);
    }
    // Sequential encoding keeps the vertex order and count, so the accessors stay valid.
    if (sequential) encoder.SetEncodingMethod(M.MESH_SEQUENTIAL_ENCODING);
    encoder.SetSpeedOptions(5, 5);
    const buf = new M.DracoInt8Array();
    const len = encoder.EncodeMeshToDracoBuffer(mesh, buf);
    if (!(len > 0)) throw new Error('Draco encoding failed');
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = buf.GetValue(i);
    M.destroy(buf);
    return { bytes, attributes: ids };
  } finally {
    M.destroy(mesh);
    M.destroy(builder);
    M.destroy(encoder);
  }
}

/**
 * Rewrite a GLB with Draco geometry and/or KTX2 textures. encoders: {draco: Draco encoder module,
 * ktx2: async (imageBytes, mimeType) → KTX2 bytes}. Returns the new GLB.
 */
export async function compressGlb(glb, { draco = null, ktx2 = null } = {}) {
  const { json, bin } = readGlb(glb);
  const keep = []; // [{bytes}] new buffer views
  const views = [];
  const addView = (bytes) => {
    views.push({ buffer: 0, byteLength: bytes.length });
    keep.push(bytes);
    return views.length - 1;
  };
  const viewMap = new Map(); // old bufferView → new index (kept data)
  const keepView = (i) => {
    if (viewMap.has(i)) return viewMap.get(i);
    const bv = json.bufferViews[i];
    const b = bin.slice(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const k = addView(b);
    if (bv.byteStride) views[k].byteStride = bv.byteStride;
    if (bv.target) views[k].target = bv.target;
    viewMap.set(i, k);
    return k;
  };
  const used = new Set(json.extensionsUsed ?? []);
  const required = new Set(json.extensionsRequired ?? []);
  const dracoAccessors = new Set();
  if (draco) {
    for (const m of json.meshes ?? [])
      for (const p of m.primitives) {
        if ((p.mode ?? 4) !== 4 || p.indices === undefined || p.extensions?.KHR_draco_mesh_compression) continue;
        const attrs = {};
        for (const [name, ai] of Object.entries(p.attributes)) {
          const a = json.accessors[ai];
          attrs[name] = { data: accessorData(json, bin, ai), size: SIZE[a.type], count: a.count };
        }
        const ind = accessorData(json, bin, p.indices);
        const r = dracoEncode(draco, { indices: Uint32Array.from(ind), attrs });
        p.extensions = { ...(p.extensions ?? {}), KHR_draco_mesh_compression: { bufferView: addView(r.bytes), attributes: r.attributes } };
        for (const ai of [...Object.values(p.attributes), p.indices]) dracoAccessors.add(ai);
      }
    if (dracoAccessors.size) {
      used.add('KHR_draco_mesh_compression');
      required.add('KHR_draco_mesh_compression');
    }
  }
  // Accessors: compressed ones lose their buffer view; the others keep theirs.
  for (const [i, a] of (json.accessors ?? []).entries()) {
    if (dracoAccessors.has(i)) {
      delete a.bufferView;
      delete a.byteOffset;
    } else if (a.bufferView !== undefined) a.bufferView = keepView(a.bufferView);
  }
  if (ktx2 && json.images?.length) {
    for (const [ti, t] of (json.textures ?? []).entries()) {
      const img = json.images[t.source];
      if (!img || img.bufferView === undefined || img.__ktx2 !== undefined) continue;
      const bv = json.bufferViews[img.bufferView];
      const src = bin.slice(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
      const k = await ktx2(src, img.mimeType);
      json.images.push({ bufferView: addView(k), mimeType: 'image/ktx2', name: `${img.name ?? `image${t.source}`}.ktx2` });
      img.__ktx2 = json.images.length - 1;
      // KHR_texture_basisu required: the texture has the KTX2 image only.
      json.textures[ti] = { ...t, extensions: { ...(t.extensions ?? {}), KHR_texture_basisu: { source: img.__ktx2 } } };
      delete json.textures[ti].source;
    }
    // Drop the PNG/JPEG images now unused.
    const usedImg = new Set((json.textures ?? []).flatMap((t) => [t.source, t.extensions?.KHR_texture_basisu?.source].filter((x) => x !== undefined)));
    const remap = new Map();
    const imgs = [];
    json.images.forEach((im, i) => {
      if (!usedImg.has(i)) return;
      remap.set(i, imgs.length);
      delete im.__ktx2;
      imgs.push(im);
    });
    for (const im of imgs) if (im.bufferView !== undefined && !views[im.bufferView]?.__new) im.bufferView = im.mimeType === 'image/ktx2' ? im.bufferView : keepView(im.bufferView);
    json.images = imgs;
    for (const t of json.textures) {
      if (t.source !== undefined) t.source = remap.get(t.source);
      if (t.extensions?.KHR_texture_basisu) t.extensions.KHR_texture_basisu.source = remap.get(t.extensions.KHR_texture_basisu.source);
    }
    used.add('KHR_texture_basisu');
    required.add('KHR_texture_basisu');
  } else for (const im of json.images ?? []) if (im.bufferView !== undefined) im.bufferView = keepView(im.bufferView);
  // New binary buffer, 4-byte aligned views.
  let size = 0;
  for (const b of keep) size += b.length + pad4(b.length);
  const out = new Uint8Array(size);
  let o = 0;
  keep.forEach((b, i) => {
    views[i].byteOffset = o;
    out.set(b, o);
    o += b.length + pad4(b.length);
  });
  json.bufferViews = views;
  json.buffers = [{ byteLength: out.length }];
  if (used.size) json.extensionsUsed = [...used];
  if (required.size) json.extensionsRequired = [...required];
  json.asset = { ...(json.asset ?? {}), generator: `${json.asset?.generator ?? 'GIS Workbench'} (Draco/KTX2: codec pack)` };
  return writeGlb(json, out);
}
