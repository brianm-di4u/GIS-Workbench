// The `tiles` bundle's I3S exports (REQ-GAP-35; crates/gw-tiles/src/i3s.rs): the SLPK's ZIP end
// record and central directory, and the uncompressed I3S geometry buffer. `b` is a wasm/abi.js
// Bundle of `tiles`; the analysis worker calls these (workers/kinds/analysis.worker.js), and so do
// the unit tests, on the same module.

const TYPES = { UInt8: 1, Int8: 2, UInt16: 3, Int16: 4, UInt32: 5, Int32: 6, UInt64: 7, Int64: 8, Float32: 9, Float64: 10 };
const ORDER = ['position', 'normal', 'uv0', 'color', 'uvRegion', 'featureId', 'faceRange'];

/** The parameters of gw_i3s_geometry for a geometryBuffer layout (I3S 1.7 geometryDefinitions). */
export function geometryParams(layout, maxVertices = 4e6) {
  const p = [layout.offset ?? 0, maxVertices];
  for (const k of ORDER) {
    const d = layout[k];
    p.push(d ? (TYPES[d.type] ?? -1) : 0, d ? (d.component ?? 1) : 0);
  }
  return p;
}

/** The legacy layout of an I3S 1.6 store (store.defaultGeometrySchema) as a geometryBuffer. */
export function legacyLayout(schema) {
  const va = schema?.vertexAttributes ?? {};
  const fa = schema?.featureAttributes ?? {};
  const one = (d) => d && { type: d.valueType, component: d.valuesPerElement };
  return { offset: 8, position: one(va.position), normal: one(va.normal), uv0: one(va.uv0), color: one(va.color), uvRegion: one(va.region), featureId: one(fa.id), faceRange: one(fa.faceRange) };
}

function call(b, fn, bytes, prm) {
  return b.guard(() => {
    const [pb, nb] = b.put(bytes);
    const [pp, np] = b.putF64(prm);
    try {
      b.check(b.x[fn](pb, bytes.byteLength, pp, prm.length), fn);
      return b.outBytes();
    } finally {
      b.free(pb, nb);
      b.free(pp, np);
    }
  });
}

/** {cdOffset, cdSize, entries} of an SLPK from its last bytes `tail` (file of `fileLength` bytes). */
export function slpkEnd(b, tail, fileLength) {
  const o = new Float64Array(call(b, 'gw_slpk_end', tail, [fileLength]).buffer);
  return { cdOffset: o[0], cdSize: o[1], entries: o[2] };
}

/** The entries of a central directory: [{name, offset (local header), csize, size, method}]. */
export function slpkDirectory(b, cd, max = 1e7) {
  const u = call(b, 'gw_slpk_directory', cd, [max]);
  return unpackEntries(u);
}

export function unpackEntries(u) {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const n = dv.getUint32(0, true);
  const dec = new TextDecoder();
  const out = new Array(n);
  let p = 4;
  for (let i = 0; i < n; i++) {
    const offset = dv.getFloat64(p, true);
    const csize = dv.getFloat64(p + 8, true);
    const size = dv.getFloat64(p + 16, true);
    const method = dv.getUint16(p + 24, true);
    const len = dv.getUint16(p + 26, true);
    out[i] = { name: dec.decode(u.subarray(p + 28, p + 28 + len)), offset, csize, size, method };
    p += 28 + len;
  }
  return out;
}

/**
 * Decode an uncompressed geometry buffer (gzip or not) → {vertexCount, featureCount, position
 * (Float32Array), normal, uv0, color (Uint8Array RGBA), uvRegion (Uint16Array), featureId
 * (Float64Array), faceRange (Uint32Array)}; absent attributes are null.
 */
export function i3sGeometry(b, bytes, layout, maxVertices = 4e6) {
  return unpackGeometry(call(b, 'gw_i3s_geometry', bytes, geometryParams(layout, maxVertices)));
}

export function unpackGeometry(u) {
  const buf = u.buffer;
  const base = u.byteOffset;
  const dv = new DataView(buf, base, u.byteLength);
  const vertexCount = dv.getUint32(0, true);
  const featureCount = dv.getUint32(4, true);
  const flags = dv.getUint32(8, true);
  let p = base + 16;
  // Copies, so each array is aligned whatever the output's offset.
  const take = (Ctor, n) => {
    const a = new Ctor(buf.slice(p, p + n * Ctor.BYTES_PER_ELEMENT));
    p += n * Ctor.BYTES_PER_ELEMENT;
    return a;
  };
  const featureId = flags & 16 ? take(Float64Array, featureCount) : null;
  const position = take(Float32Array, vertexCount * 3);
  const normal = flags & 1 ? take(Float32Array, vertexCount * 3) : null;
  const uv0 = flags & 2 ? take(Float32Array, vertexCount * 2) : null;
  const faceRange = flags & 32 ? take(Uint32Array, featureCount * 2) : null;
  const uvRegion = flags & 8 ? take(Uint16Array, vertexCount * 4) : null;
  const color = flags & 4 ? take(Uint8Array, vertexCount * 4) : null;
  return { vertexCount, featureCount, position, normal, uv0, color, uvRegion, featureId, faceRange };
}
