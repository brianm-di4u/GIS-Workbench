// glTF extensions for the 3D view and 3D Tiles (REQ-FMT-34, FC-08, FC-09, S-47):
// - meshopt geometry (EXT_meshopt_compression / KHR_meshopt_compression): three.js's decoder in the
//   lazy three block;
// - Draco geometry (KHR_draco_mesh_compression, and 3DTILES_draco_point_compression in pnts):
//   three.js's DRACOLoader with Google's draco_decoder.wasm and its wrapper (Apache-2.0);
// - KTX2 / Basis Universal textures (KHR_texture_basisu): three.js's KTX2Loader with Binomial's
//   basis_transcoder.wasm and its wrapper (Apache-2.0).
// The decoders are lazy verified blocks of the file (wasm-draco, data-draco-glue, wasm-basis,
// data-basis-glue): the boot loader checks their SHA-256 and they reach the loaders as blob: URLs,
// so nothing is fetched and the CSP is unchanged (connect-src blob:, worker-src blob:). They load
// only when a model uses them. GIS Workbench Lite leaves them out with the rest of 3D.

/** extensionsUsed and extensionsRequired of a .gltf (JSON) or .glb (JSON chunk): {used, required} sets, and the parsed JSON. */
import { gwError } from '../i18n/index.js';

export function gltfExtensions(bytes) {
  let text = null;
  if (bytes.length >= 20 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) {
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

/**
 * Throws a named error for content this build cannot decode. Draco and KTX2 are decoded from 2.1;
 * a build without the decoder blocks (Lite) still refuses by name.
 */
export function refuseUndecodable(bytes, name, gw) {
  const { used, required } = gltfExtensions(bytes);
  const has = (b) => !gw || !!gw.manifest?.blocks?.[b];
  if (used.has('KHR_draco_mesh_compression') && !has('wasm-draco')) throw gwError('{file}: Draco-compressed meshes (KHR_draco_mesh_compression) need the Draco decoder, which this file leaves out: open the Standard file', { file: name }, 'E_NO_DRACO');
  if (used.has('KHR_texture_basisu') && !has('wasm-basis')) {
    if (required.has('KHR_texture_basisu')) throw gwError('{file}: KTX2 / Basis Universal textures (KHR_texture_basisu, required) need the Basis transcoder, which this file leaves out: open the Standard file', { file: name }, 'E_NO_BASIS');
  }
}

// ---- decoders from verified blocks ----

const blobUrl = (u8, type) => URL.createObjectURL(new Blob([u8], { type }));
let dracoP = null;
/** One DRACOLoader per page (its worker pool is shared), fed from the verified blocks. */
export function dracoLoader(T, gw) {
  if (!T.DRACOLoader) return Promise.reject(new Error('the 3D library block has no Draco loader'));
  dracoP ??= (async () => {
    const [glue, wasm] = await Promise.all([gw.bytes('data-draco-glue'), gw.bytes('wasm-draco')]);
    const d = new T.DRACOLoader();
    // Custom paths (an object): the WASM build only, no asm.js fallback is fetched.
    d.setDecoderPath({ js: blobUrl(glue, 'text/javascript'), wasm: blobUrl(wasm, 'application/wasm') });
    d.setWorkerLimit(Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)));
    await d.preload()._initDecoder?.();
    return d;
  })();
  dracoP.catch(() => (dracoP = null));
  return dracoP;
}

// KTX2Loader fetches basis_transcoder.js/.wasm under its transcoder path through its manager; the
// manager maps those two names to blob: URLs of the verified blocks.
let basisUrls = null;
const activeManagers = new Set();
const ktx2ByRenderer = new WeakMap();
const ktx2Fallback = { loader: null };
export async function ktx2Loader(T, gw, renderer) {
  if (!T.KTX2Loader) throw new Error('the 3D library block has no KTX2 loader');
  const hit = renderer ? ktx2ByRenderer.get(renderer) : ktx2Fallback.loader;
  if (hit) return hit;
  basisUrls ??= (async () => {
    const [glue, wasm] = await Promise.all([gw.bytes('data-basis-glue'), gw.bytes('wasm-basis')]);
    return { 'gw-basis/basis_transcoder.js': blobUrl(glue, 'text/javascript'), 'gw-basis/basis_transcoder.wasm': blobUrl(wasm, 'application/wasm') };
  })();
  basisUrls.catch(() => (basisUrls = null));
  const urls = await basisUrls;
  inlineWasmFetch();
  const manager = new T.LoadingManager();
  // Texture URIs of the model being parsed resolve through that model's own manager (its blob: URLs).
  manager.setURLModifier((u) => {
    if (urls[u]) return urls[u];
    for (const m of activeManagers) {
      const r = m.resolveURL(u);
      if (r !== u) return r;
    }
    return u;
  });
  const k = new T.KTX2Loader(manager);
  k.setTranscoderPath('gw-basis/');
  k.setWorkerLimit(2);
  if (renderer) k.detectSupport(renderer);
  else {
    // No renderer (tests, headless conversion): uncompressed RGBA output.
    k.workerConfig = { astcSupported: false, astcHDRSupported: false, etc1Supported: false, etc2Supported: false, dxtSupported: false, bptcSupported: false, pvrtcSupported: false };
  }
  if (renderer) ktx2ByRenderer.set(renderer, k);
  else ktx2Fallback.loader = k;
  return k;
}

// zstddec (KTX2 with Zstandard supercompression) loads its WASM with fetch('data:application/wasm;base64,…'),
// which connect-src blob: refuses; serve exactly that request from the inline bytes (as geotiff.js does in its worker).
function inlineWasmFetch() {
  const WASM_DATA = 'data:application/wasm;base64,';
  const g = globalThis;
  if (!g.fetch || g.fetch.__gwInlineWasm) return;
  const fetch0 = g.fetch.bind(g);
  const inline = (u, ...rest) => {
    if (typeof u === 'string' && u.startsWith(WASM_DATA)) {
      const bin = atob(u.slice(WASM_DATA.length));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return Promise.resolve(new Response(bytes, { headers: { 'content-type': 'application/wasm' } }));
    }
    return fetch0(u, ...rest);
  };
  inline.__gwInlineWasm = true;
  g.fetch = inline;
}

/**
 * A GLTFLoader that decodes meshopt geometry, and Draco geometry and KTX2 textures when `bytes`
 * use them (the decoders load only then). opts: {gw, renderer, bytes}.
 */
export async function gltfLoader(T, manager, { gw = null, renderer = null, bytes = null } = {}) {
  const loader = new T.GLTFLoader(manager);
  if (T.MeshoptDecoder) loader.setMeshoptDecoder(T.MeshoptDecoder);
  if (gw && bytes) {
    const { used } = gltfExtensions(bytes);
    if (used.has('KHR_draco_mesh_compression') && gw.manifest?.blocks?.['wasm-draco']) loader.setDRACOLoader(await dracoLoader(T, gw));
    if (used.has('KHR_texture_basisu') && gw.manifest?.blocks?.['wasm-basis']) loader.setKTX2Loader(await ktx2Loader(T, gw, renderer));
  }
  return loader;
}

/**
 * Decode a Draco buffer (3DTILES_draco_point_compression): `ids` maps three.js attribute names to
 * Draco unique ids, `types` to typed-array constructor names. Resolves to a BufferGeometry.
 */
export async function decodeDraco(T, gw, buf, ids, types) {
  const d = await dracoLoader(T, gw);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => d.decodeDracoFile(ab, res, ids, types, T.LinearSRGBColorSpace, rej).catch?.(rej));
}

/** Parse glTF/GLB bytes with `manager` (its URL modifier serves the model's resources): the gltf result. */
export async function parseGltf(T, manager, bytes, opts = {}) {
  const loader = await gltfLoader(T, manager, { ...opts, bytes });
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  activeManagers.add(manager);
  try {
    return await new Promise((res, rej) => loader.parse(buf, '', res, rej));
  } finally {
    activeManagers.delete(manager);
  }
}
