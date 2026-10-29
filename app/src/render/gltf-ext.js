// glTF extensions for the 3D view and 3D Tiles: meshopt-compressed geometry is decoded
// (EXT_meshopt_compression / KHR_meshopt_compression, three.js's decoder in the lazy three block);
// Draco geometry and required KTX2 textures are refused by name before loading, instead of
// surfacing the loader's "setDRACOLoader/setKTX2Loader must be called" errors.

/** extensionsUsed and extensionsRequired of a .gltf (JSON) or .glb (JSON chunk): {used, required} sets, and the parsed JSON. */
export function gltfExtensions(bytes) {
  let text = null;
  if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = dv.getUint32(12, true);
    if (dv.getUint32(16, true) === 0x4e4f534a && 20 + len <= bytes.length) text = new TextDecoder().decode(bytes.subarray(20, 20 + len));
  } else if (bytes[0] === 0x7b) text = new TextDecoder().decode(bytes);
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* the loader reports malformed JSON */
  }
  return { used: new Set(json?.extensionsUsed ?? []), required: new Set(json?.extensionsRequired ?? []), json };
}

/** Throws a named error for content this build cannot decode. */
export function refuseUndecodable(bytes, name) {
  const { used, required } = gltfExtensions(bytes);
  if (used.has('KHR_draco_mesh_compression')) throw new Error(`${name}: Draco-compressed meshes (KHR_draco_mesh_compression) are not decoded in this release; re-export the model without Draco`);
  if (required.has('KHR_texture_basisu')) throw new Error(`${name}: KTX2 / Basis Universal textures (KHR_texture_basisu, required) are not decoded in this release; re-export with PNG or JPEG textures`);
}

/** A GLTFLoader that decodes meshopt geometry when the decoder is in the three block. */
export function gltfLoader(T, manager) {
  const loader = new T.GLTFLoader(manager);
  if (T.MeshoptDecoder) loader.setMeshoptDecoder(T.MeshoptDecoder);
  return loader;
}
