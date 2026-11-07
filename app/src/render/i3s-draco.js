// Draco-compressed I3S geometry (REQ-GAP-35; I3S compressedAttributes): Google's Draco decoder
// (the verified wasm-draco and data-draco-glue blocks, Apache-2.0) in a worker of its own, with
// the I3S metadata three.js's DRACOLoader does not read: the position attribute's i3s-scale_x /
// i3s-scale_y, and the generic attributes named by i3s-attribute-type (feature-index with its
// i3s-feature-ids array, uv-region). The worker inflates gzip resources itself
// (DecompressionStream), so the main thread only moves bytes.

/**
 * Decode one I3S Draco buffer with a DracoDecoderModule `M` → {kind ('mesh' | 'points'),
 * vertexCount, position (Float32Array, scale applied), normal, uv0, color (Uint8Array RGBA),
 * uvRegion (Uint16Array), featureIndex (Uint32Array), featureIds (Float64Array), indices
 * (Uint32Array, meshes)}. Self-contained: the worker runs its source text.
 */
export function decodeI3sDraco(M, bytes) {
  const dec = new M.Decoder();
  const buf = new M.DecoderBuffer();
  const mq = new M.MetadataQuerier();
  const keep = [dec, buf, mq];
  try {
    buf.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
    const type = dec.GetEncodedGeometryType(buf);
    const mesh = type === M.TRIANGULAR_MESH;
    if (!mesh && type !== M.POINT_CLOUD) throw new Error('I3S Draco: not a Draco mesh or point cloud');
    const geo = mesh ? new M.Mesh() : new M.PointCloud();
    keep.push(geo);
    const st = mesh ? dec.DecodeBufferToMesh(buf, geo) : dec.DecodeBufferToPointCloud(buf, geo);
    if (!st.ok() || !geo.ptr) throw new Error(`I3S Draco: ${st.error_msg()}`);
    const n = geo.num_points();
    const out = { kind: mesh ? 'mesh' : 'points', vertexCount: n, position: null, normal: null, uv0: null, color: null, uvRegion: null, featureIndex: null, featureIds: null, indices: null };
    const meta = (i) => {
      const md = dec.GetAttributeMetadata(geo, i);
      const r = {};
      if (!md.ptr) return r;
      const k = mq.NumEntries(md);
      for (let e = 0; e < k; e++) {
        const name = mq.GetEntryName(md, e);
        if (name === 'i3s-scale_x' || name === 'i3s-scale_y') r[name] = mq.GetDoubleEntry(md, name);
        else if (name === 'i3s-attribute-type') r[name] = mq.GetStringEntry(md, name);
        else if (name === 'i3s-feature-ids') {
          const a = new M.DracoInt32Array();
          mq.GetIntEntryArray(md, name, a);
          const ids = new Float64Array(a.size());
          for (let j = 0; j < ids.length; j++) ids[j] = a.GetValue(j);
          M.destroy(a);
          r.ids = ids;
        }
      }
      return r;
    };
    const floats = (a, comps) => {
      const bytesLen = n * comps * 4;
      const ptr = M._malloc(bytesLen);
      try {
        dec.GetAttributeDataArrayForAllPoints(geo, a, M.DT_FLOAT32, bytesLen, ptr);
        return new Float32Array(M.HEAPF32.buffer, ptr, n * comps).slice();
      } finally {
        M._free(ptr);
      }
    };
    const ints = (a, comps, dt, Ctor, heap) => {
      const bytesLen = n * comps * Ctor.BYTES_PER_ELEMENT;
      const ptr = M._malloc(bytesLen);
      try {
        dec.GetAttributeDataArrayForAllPoints(geo, a, dt, bytesLen, ptr);
        return new Ctor(M[heap].buffer, ptr, n * comps).slice();
      } finally {
        M._free(ptr);
      }
    };
    for (let i = 0; i < geo.num_attributes(); i++) {
      const a = dec.GetAttribute(geo, i);
      const t = a.attribute_type();
      const c = a.num_components();
      const md = meta(i);
      if (t === M.POSITION) {
        const p = floats(a, c);
        const sx = md['i3s-scale_x'] ?? 1;
        const sy = md['i3s-scale_y'] ?? 1;
        if (sx !== 1 || sy !== 1)
          for (let v = 0; v < n; v++) {
            p[c * v] *= sx;
            p[c * v + 1] *= sy;
          }
        out.position = c === 3 ? p : null;
      } else if (t === M.NORMAL && c === 3) out.normal = floats(a, 3);
      else if (t === M.TEX_COORD && c === 2) out.uv0 = floats(a, 2);
      else if (t === M.COLOR) {
        const u = ints(a, c, M.DT_UINT8, Uint8Array, 'HEAPU8');
        const rgba = new Uint8Array(n * 4).fill(255);
        for (let v = 0; v < n; v++) for (let k = 0; k < Math.min(4, c); k++) rgba[4 * v + k] = u[c * v + k];
        out.color = rgba;
      } else if (t === M.GENERIC && md['i3s-attribute-type'] === 'feature-index') {
        out.featureIndex = ints(a, 1, M.DT_UINT32, Uint32Array, 'HEAPU32');
        out.featureIds = md.ids ?? null;
      } else if (t === M.GENERIC && md['i3s-attribute-type'] === 'uv-region' && c === 4) out.uvRegion = ints(a, 4, M.DT_UINT16, Uint16Array, 'HEAPU16');
    }
    if (!out.position) throw new Error('I3S Draco: no position attribute');
    if (mesh) {
      const nf = geo.num_faces();
      const bytesLen = nf * 3 * 4;
      const ptr = M._malloc(bytesLen);
      try {
        dec.GetTrianglesUInt32Array(geo, bytesLen, ptr);
        out.indices = new Uint32Array(M.HEAPU32.buffer, ptr, nf * 3).slice();
      } finally {
        M._free(ptr);
      }
      for (let i = 0; i < out.indices.length; i++) if (out.indices[i] >= n) throw new Error('I3S Draco: a face index is out of range');
    }
    return out;
  } finally {
    for (const o of keep) M.destroy(o);
  }
}

/** The worker's source: the glue, then a handler that inflates and decodes. */
function workerSource(glue) {
  return `${glue}
const decodeI3sDraco = ${decodeI3sDraco.toString()};
let ready = null;
async function inflate(u8) {
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return u8;
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
self.onmessage = async (ev) => {
  const { id, wasm, bytes } = ev.data;
  try {
    if (wasm) {
      ready = new Promise((res) => DracoDecoderModule({ wasmBinary: wasm, onModuleLoaded: (m) => res(m) }));
      await ready;
      self.postMessage({ id, ok: true });
      return;
    }
    const M = await ready;
    const r = decodeI3sDraco(M, await inflate(bytes));
    self.postMessage({ id, ok: true, r }, Object.values(r).filter((v) => v && v.buffer).map((v) => v.buffer));
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};
`;
}

/**
 * A small pool of Draco workers fed from the verified blocks: decode(bytes) → the result of
 * decodeI3sDraco. `gw` is the boot loader (gw.bytes(block)).
 */
export function dracoPool(gw, size = Math.max(1, Math.min(3, (globalThis.navigator?.hardwareConcurrency || 2) - 1))) {
  let start = null;
  let next = 1;
  const waiting = new Map();
  const workers = [];
  let rr = 0;
  const init = () =>
    (start ??= (async () => {
      const [glue, wasm] = await Promise.all([gw.bytes('data-draco-glue'), gw.bytes('wasm-draco')]);
      const url = URL.createObjectURL(new Blob([workerSource(new TextDecoder().decode(glue))], { type: 'text/javascript' }));
      for (let i = 0; i < size; i++) {
        const w = new Worker(url);
        w.onmessage = (ev) => {
          const p = waiting.get(ev.data.id);
          if (!p) return;
          waiting.delete(ev.data.id);
          if (ev.data.ok) p.resolve(ev.data.r);
          else p.reject(new Error(ev.data.error));
        };
        workers.push(w);
      }
      await Promise.all(workers.map((w) => post(w, { wasm: wasm.slice() })));
      URL.revokeObjectURL(url);
    })().catch((e) => {
      start = null;
      for (const w of workers.splice(0)) w.terminate();
      throw e;
    }));
  const post = (w, msg, transfer = []) =>
    new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      w.postMessage({ id, ...msg }, transfer);
    });
  return {
    async decode(bytes) {
      await init();
      const w = workers[rr++ % workers.length];
      const copy = bytes.slice();
      return post(w, { bytes: copy }, [copy.buffer]);
    },
    dispose() {
      for (const w of workers.splice(0)) w.terminate();
      for (const p of waiting.values()) p.reject(new Error('cancelled'));
      waiting.clear();
      start = null;
    },
  };
}
