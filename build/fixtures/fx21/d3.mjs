// FX-21 d3 (SDP-2.1 group d3): synthetic 3D content for the 2.1 readers and writers.
//   pnts/      every pnts encoding: float RGB, quantised + oct normals + RGBA, RGB565 + batch
//              table, constant RGBA + BATCH_ID, Draco (3DTILES_draco_point_compression)
//   i3dm/      embedded GLB with NORMAL_UP/RIGHT, quantised + OCT32P + SCALE_NON_UNIFORM,
//              external glTF URI + EAST_NORTH_UP + batch table
//   cmpt/      pnts + i3dm + b3dm, and a composite of composites
//   implicit-octree/   point cloud as a 3D Tiles 1.1 implicit octree (binary subtrees)
//   implicit-quadtree/ b3dm tiles under a quadtree with JSON subtrees and a region volume
//   gltf/      Draco and KTX2 (ETC1S) GLBs written by the app's compressor with the codec encoders
//   qmesh-4326/, qmesh-3857/  quantized-mesh tile sets (layer.json + z/x/y.terrain) from the
//              Rust writer (needs the tiles bundle in CARGO_TARGET_DIR)
//   truth.json  counts, bounds and values every check compares against
// Each file is checked by an independent tool in tests/unit/fx21-d3.test.js (glTF-Validator,
// 3d-tiles-validator, @here/quantized-mesh-decoder).

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writePnts, writeI3dm, writeB3dm, writeCmpt, writePointCloudTileset, enuToEcef, geoToEcef, write3tz } from '../../../app/src/formats/tiles3d-write.js';
import { compressGlb, readGlb } from '../../../app/src/formats/gltf-compress.js';
import { writeQuantizedMesh } from '../../../app/src/formats/qmesh-write.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const O = { lat: 39.7392, lon: -104.9903, h: 1600 }; // Denver
const te = new TextEncoder();

/** A small textured box GLB (24 vertices, 12 triangles, a 64² PNG-free RGBA texture as PNG via a stored zlib). */
export function boxGlb({ size = 2, texture = true } = {}) {
  const s = size / 2;
  const faces = [
    [[1, 0, 0], [[s, -s, -s], [s, s, -s], [s, s, s], [s, -s, s]]],
    [[-1, 0, 0], [[-s, -s, s], [-s, s, s], [-s, s, -s], [-s, -s, -s]]],
    [[0, 1, 0], [[-s, s, -s], [-s, s, s], [s, s, s], [s, s, -s]]],
    [[0, -1, 0], [[-s, -s, s], [-s, -s, -s], [s, -s, -s], [s, -s, s]]],
    [[0, 0, 1], [[-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s]]],
    [[0, 0, -1], [[s, -s, -s], [-s, -s, -s], [-s, s, -s], [s, s, -s]]],
  ];
  const P = [];
  const N = [];
  const UV = [];
  const I = [];
  faces.forEach(([n, q], f) => {
    for (const v of q) (P.push(...v), N.push(...n));
    UV.push(0, 0, 1, 0, 1, 1, 0, 1);
    I.push(4 * f, 4 * f + 1, 4 * f + 2, 4 * f, 4 * f + 2, 4 * f + 3);
  });
  const pos = new Float32Array(P);
  const nrm = new Float32Array(N);
  const uv = new Float32Array(UV);
  const ind = new Uint16Array(I);
  const png = texture ? pngRgba(64, 64, (x, y) => [((x >> 3) + (y >> 3)) % 2 ? 230 : 40, 120, (x * 4) & 255, 255]) : null;
  const parts = [pos, nrm, uv, ind, ...(png ? [png] : [])].map((a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  const offs = [];
  let o = 0;
  for (const p of parts) {
    offs.push(o);
    o += p.length + ((4 - (p.length % 4)) % 4);
  }
  const bin = new Uint8Array(o);
  parts.forEach((p, i) => bin.set(p, offs[i]));
  const json = {
    asset: { version: '2.0', generator: 'GIS Workbench FX-21 d3' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, ...(png ? { material: 0 } : {}) }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-s, -s, -s], max: [s, s, s] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 24, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: offs[0], byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offs[1], byteLength: nrm.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offs[2], byteLength: uv.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offs[3], byteLength: ind.byteLength, target: 34963 },
      ...(png ? [{ buffer: 0, byteOffset: offs[4], byteLength: png.length }] : []),
    ],
    buffers: [{ byteLength: bin.length }],
    ...(png ? { materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }], textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9729, minFilter: 9987 }], images: [{ bufferView: 4, mimeType: 'image/png' }] } : {}),
  };
  const j = te.encode(JSON.stringify(json));
  const jl = j.length + ((4 - (j.length % 4)) % 4);
  const out = new Uint8Array(12 + 8 + jl + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jl, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jl);
  out.set(j, 20);
  dv.setUint32(20 + jl, bin.length, true);
  dv.setUint32(24 + jl, 0x004e4942, true);
  out.set(bin, 28 + jl);
  return { glb: out, rgba: png ? rgba64() : null };
}
const rgba64 = () => {
  const d = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) d.set([((x >> 3) + (y >> 3)) % 2 ? 230 : 40, 120, (x * 4) & 255, 255], 4 * (y * 64 + x));
  return { width: 64, height: 64, data: d };
};

/** An uncompressed (stored-deflate) RGBA PNG. */
function pngRgba(w, h, px) {
  const raw = new Uint8Array(h * (1 + 4 * w));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (1 + 4 * w) + 1 + 4 * x);
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const adler = (b) => {
    let a = 1;
    let s = 0;
    for (const x of b) (a = (a + x) % 65521), (s = (s + a) % 65521);
    return ((s << 16) | a) >>> 0;
  };
  const blocks = [];
  for (let o = 0; o < raw.length; o += 65535) {
    const c = raw.subarray(o, o + 65535);
    blocks.push(Uint8Array.of(o + 65535 >= raw.length ? 1 : 0, c.length & 255, c.length >> 8, ~c.length & 255, (~c.length >> 8) & 255), c);
  }
  const z = concat([Uint8Array.of(0x78, 0x01), ...blocks, be32(adler(raw))]);
  const chunk = (type, data) => concat([be32(data.length), te.encode(type), data, be32(crc(concat([te.encode(type), data])))]);
  const ihdr = concat([be32(w), be32(h), Uint8Array.of(8, 6, 0, 0, 0)]);
  return concat([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))]);
}
const be32 = (v) => Uint8Array.of(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const concat = (a) => {
  const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of a) (out.set(x, o), (o += x.length));
  return out;
};

/** n points on a 50 × 50 m hill in ENU metres, with colours, normals and attributes. */
function hill(n) {
  const pos = new Float64Array(3 * n);
  const rgb = new Uint8Array(3 * n);
  const nrm = new Float32Array(3 * n);
  const intensity = new Uint16Array(n);
  const cls = new Uint8Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const x = rnd() * 50 - 25;
    const y = rnd() * 50 - 25;
    const z = 10 * Math.exp(-(x * x + y * y) / 300);
    pos.set([x, y, z], 3 * i);
    const dzdx = (-2 * x * z) / 300;
    const dzdy = (-2 * y * z) / 300;
    const l = Math.hypot(dzdx, dzdy, 1);
    nrm.set([-dzdx / l, -dzdy / l, 1 / l], 3 * i);
    rgb.set([Math.round(z * 25), 128, 255 - Math.round(z * 25)], 3 * i);
    intensity[i] = Math.round(100 + z * 50);
    cls[i] = z > 5 ? 6 : 2;
  }
  return { pos, rgb, nrm, intensity, cls };
}

const ecefOf = (enu) => {
  const M = enuToEcef(O.lat, O.lon, O.h);
  const out = new Float64Array(enu.length);
  for (let i = 0; i < enu.length; i += 3) {
    const [x, y, z] = [enu[i], enu[i + 1], enu[i + 2]];
    out[i] = M[0] * x + M[4] * y + M[8] * z + M[12];
    out[i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
    out[i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
  }
  return out;
};
const bounds = (a) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], a[i + k])), (hi[k] = Math.max(hi[k], a[i + k]));
  return { min: lo, max: hi };
};

/** Draco point cloud buffer (POSITION float, RGB uint8) → {bytes, ids}. */
function dracoPoints(M, pos, rgb) {
  const enc = new M.Encoder();
  const b = new M.PointCloudBuilder();
  const pc = new M.PointCloud();
  const n = pos.length / 3;
  const pid = b.AddFloatAttribute(pc, M.POSITION, n, 3, Float32Array.from(pos));
  const cid = b.AddUInt8Attribute(pc, M.COLOR, n, 3, rgb);
  enc.SetAttributeQuantization(M.POSITION, 16);
  enc.SetSpeedOptions(5, 5);
  const buf = new M.DracoInt8Array();
  const len = enc.EncodePointCloudToDracoBuffer(pc, false, buf);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = buf.GetValue(i);
  [buf, pc, b, enc].forEach((x) => M.destroy(x));
  return { bytes, ids: { POSITION: pid, RGB: cid } };
}

/** The tiles bundle (Rust quantized-mesh writer) from the cargo target dir, or null. */
async function tilesBundle() {
  const tdir = process.env.CARGO_TARGET_DIR ?? join(ROOT, 'crates', 'target');
  const f = join(tdir, 'wasm32-unknown-unknown', 'release', 'gw_bundle_tiles.wasm');
  if (!existsSync(f)) return null;
  const { instance } = await WebAssembly.instantiate(readFileSync(f), {});
  const x = instance.exports;
  return async (z, prm) => {
    const pz = x.gw_alloc(z.byteLength);
    new Float32Array(x.memory.buffer, pz, z.length).set(z);
    const pp = x.gw_alloc(prm.byteLength);
    new Float64Array(x.memory.buffer, pp, prm.length).set(prm);
    const code = x.gw_qmesh_tile(pz, z.length, pp, prm.length);
    x.gw_free(pz, z.byteLength);
    x.gw_free(pp, prm.byteLength);
    if (code !== 0) {
      const p = x.gw_alloc(512);
      const k = x.gw_last_error(p, 512);
      const msg = new TextDecoder().decode(new Uint8Array(x.memory.buffer, p, Math.min(k, 512)));
      x.gw_free(p, 512);
      throw new Error(msg);
    }
    return new Uint8Array(x.memory.buffer, x.gw_out_ptr(), x.gw_out_len()).slice();
  };
}

export async function generate(outDir) {
  const made = [];
  const truth = { origin: O, pnts: {}, i3dm: {}, cmpt: {}, implicit: {}, gltf: {}, qmesh: {} };
  const put = (rel, bytes) => {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, bytes);
    made.push(rel);
  };
  const draco3d = (await import('draco3d')).default;
  const dracoEnc = await draco3d.createEncoderModule({});

  // ---- pnts: one file per encoding; positions in ECEF with an RTC centre ----
  const H = hill(2000);
  const W = ecefOf(H.pos);
  const rtc = geoToEcef(O.lat, O.lon, O.h);
  const recordPnts = (name, extra = {}) => (truth.pnts[name] = { points: 2000, ...bounds(W), ...extra });
  put('pnts/float-rgb.pnts', writePnts({ positions: W, colors: H.rgb }, { rtc }));
  recordPnts('float-rgb.pnts', { attributes: ['RGB'] });
  // ENU normals → ECEF for the oct-encoded variant.
  const M = enuToEcef(O.lat, O.lon, O.h);
  const nE = new Float32Array(H.nrm.length);
  for (let i = 0; i < H.nrm.length; i += 3) for (let k = 0; k < 3; k++) nE[i + k] = M[k] * H.nrm[i] + M[4 + k] * H.nrm[i + 1] + M[8 + k] * H.nrm[i + 2];
  const rgba = new Uint8Array(4 * 2000);
  for (let i = 0; i < 2000; i++) rgba.set([H.rgb[3 * i], H.rgb[3 * i + 1], H.rgb[3 * i + 2], 200], 4 * i);
  put('pnts/quantized-octnormals-rgba.pnts', writePnts({ positions: W, colors: rgba, colorSize: 4, normals: nE }, { rtc, quantize: true, octNormals: true }));
  recordPnts('quantized-octnormals-rgba.pnts', { attributes: ['RGBA', 'NORMAL'], tol: 0.01 });
  put('pnts/rgb565-batch.pnts', writePnts({ positions: W, colors: H.rgb, batch: { Intensity: H.intensity, Classification: H.cls } }, { rtc, rgb565: true }));
  const st = (a) => ({ min: Math.min(...a), max: Math.max(...a), mean: a.reduce((s, v) => s + v, 0) / a.length });
  recordPnts('rgb565-batch.pnts', { attributes: ['RGB'], properties: ['Intensity', 'Classification'], stats: { Intensity: st(H.intensity), Classification: st(H.cls) } });
  put('pnts/constant-rgba.pnts', writePnts({ positions: W }, { rtc, constantRgba: [255, 0, 0, 255] }));
  recordPnts('constant-rgba.pnts', { attributes: ['CONSTANT_RGBA'] });
  {
    // Draco: positions relative to the RTC centre, RGB.
    const rel = new Float32Array(W.length);
    for (let i = 0; i < W.length; i++) rel[i] = W[i] - rtc[i % 3];
    const d = dracoPoints(dracoEnc, rel, H.rgb);
    const ft = { POINTS_LENGTH: 2000, RTC_CENTER: rtc, POSITION: { byteOffset: 0 }, RGB: { byteOffset: 0 }, extensions: { '3DTILES_draco_point_compression': { properties: d.ids, byteOffset: 0, byteLength: d.bytes.length } } };
    const ftj = te.encode(JSON.stringify(ft));
    const ftjPad = ftj.length + ((8 - ((28 + ftj.length) % 8)) % 8);
    const ftb = d.bytes.length + ((8 - (d.bytes.length % 8)) % 8);
    const out = new Uint8Array(28 + ftjPad + ftb);
    const dv = new DataView(out.buffer);
    out.set(te.encode('pnts'), 0);
    dv.setUint32(4, 1, true);
    dv.setUint32(8, out.length, true);
    dv.setUint32(12, ftjPad, true);
    dv.setUint32(16, ftb, true);
    out.fill(0x20, 28, 28 + ftjPad);
    out.set(ftj, 28);
    out.set(d.bytes, 28 + ftjPad);
    put('pnts/draco.pnts', out);
    recordPnts('draco.pnts', { attributes: ['RGB', 'draco'], tol: 0.05 });
  }

  // ---- i3dm ----
  const { glb: box, rgba: boxTex } = boxGlb();
  const plain = boxGlb({ texture: false }).glb;
  const instEnu = new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 0, 20, 20, 5]);
  const instW = ecefOf(instEnu);
  const up = new Float32Array(15);
  const right = new Float32Array(15);
  for (let i = 0; i < 5; i++) {
    // up = local up, right = local east, turned by i × 30° about up.
    const a = (i * Math.PI) / 6;
    const e = [Math.cos(a), Math.sin(a), 0];
    for (let k = 0; k < 3; k++) {
      up[3 * i + k] = M[8 + k];
      right[3 * i + k] = M[k] * e[0] + M[4 + k] * e[1];
    }
  }
  put('i3dm/embedded-normals.i3dm', writeI3dm({ glb: box, positions: instW, up, right }, { rtc }));
  truth.i3dm['embedded-normals.i3dm'] = { instances: 5, ...bounds(instW) };
  put('i3dm/quantized-oct-scale.i3dm', writeI3dm({ glb: plain, positions: instW, up, right, scaleNonUniform: new Float32Array([1, 1, 1, 2, 2, 2, 1, 1, 3, 0.5, 0.5, 0.5, 1, 2, 1]) }, { rtc, quantize: true, octNormals: true }));
  truth.i3dm['quantized-oct-scale.i3dm'] = { instances: 5, ...bounds(instW), tol: 0.01 };
  put('i3dm/box.glb', plain);
  put('i3dm/external-enu-batch.i3dm', writeI3dm({ uri: 'box.glb', positions: instW, eastNorthUp: true, scale: new Float32Array([1, 2, 3, 1, 1]), batch: { Height: new Float32Array([1, 2, 3, 4, 5]), Name: ['a', 'b', 'c', 'd', 'e'] } }, { rtc }));
  truth.i3dm['external-enu-batch.i3dm'] = { instances: 5, ...bounds(instW), properties: ['Height', 'Name'] };

  // ---- cmpt ----
  const b3dmTile = writeB3dm(plain, { rtc: geoToEcef(O.lat, O.lon, O.h + 30) });
  const pntsTile = writePnts({ positions: W.subarray(0, 300) }, { rtc });
  const i3dmTile = writeI3dm({ glb: plain, positions: instW, eastNorthUp: true }, { rtc });
  put('cmpt/composite.cmpt', writeCmpt([pntsTile, i3dmTile, b3dmTile]));
  truth.cmpt['composite.cmpt'] = { points: 100, instances: 5, inner: 3 };
  put('cmpt/composite-of-composite.cmpt', writeCmpt([writeCmpt([pntsTile, b3dmTile]), writeCmpt([i3dmTile])]));
  truth.cmpt['composite-of-composite.cmpt'] = { points: 100, instances: 5, inner: 2 };
  put('cmpt/b3dm-only.b3dm', b3dmTile);

  // ---- implicit octree (point cloud, the app's own writer) ----
  const big = hill(60000);
  const oct = writePointCloudTileset({ positions: big.pos, colors: big.rgb, batch: { Intensity: big.intensity } }, O, { maxPoints: 8000, subtreeLevels: 2 });
  for (const [k, v] of Object.entries(oct.files)) put(`implicit-octree/${k}`, v);
  truth.implicit.octree = { ...oct.stats };
  // ---- implicit quadtree: b3dm content, JSON subtrees, region volume ----
  {
    const d2r = Math.PI / 180;
    const region = [(O.lon - 0.001) * d2r, (O.lat - 0.001) * d2r, (O.lon + 0.001) * d2r, (O.lat + 0.001) * d2r, O.h, O.h + 50];
    const ts = { asset: { version: '1.1' }, geometricError: 200, root: { boundingVolume: { region }, geometricError: 100, refine: 'REPLACE', content: { uri: 'content/{level}/{x}/{y}.b3dm' }, implicitTiling: { subdivisionScheme: 'QUADTREE', subtreeLevels: 2, availableLevels: 2, subtrees: { uri: 'subtrees/{level}.{x}.{y}.json' } } } };
    put('implicit-quadtree/tileset.json', te.encode(JSON.stringify(ts, null, 1)));
    // Level 0 and three of the four level-1 tiles (sparse): tile bits 0,1,2,4 (Morton 0,1,3).
    put('implicit-quadtree/subtrees/0.0.0.json', te.encode(JSON.stringify({ buffers: [{ byteLength: 8, uri: '0.0.0.bin' }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 1 }], tileAvailability: { bitstream: 0, availableCount: 4 }, contentAvailability: [{ bitstream: 0, availableCount: 4 }], childSubtreeAvailability: { constant: 0 } })));
    put('implicit-quadtree/subtrees/0.0.0.bin', Uint8Array.of(0b10111, 0, 0, 0, 0, 0, 0, 0));
    const tiles = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]];
    for (const [l, x, y] of tiles) {
      const lon = O.lon - 0.001 + ((x + 0.5) * 0.002) / 2 ** l;
      const lat = O.lat - 0.001 + ((y + 0.5) * 0.002) / 2 ** l;
      put(`implicit-quadtree/content/${l}/${x}/${y}.b3dm`, writeB3dm(plain, { rtc: geoToEcef(lat, lon, O.h + 1) }));
    }
    // A Y-up glTF at an RTC centre in ECEF is not upright on the globe, but the counts and bounds are what is checked.
    truth.implicit.quadtree = { tiles: 4, subtrees: 1 };
  }

  // ---- Draco and KTX2 glTF (the app's compressor, the codec-pack encoders) ----
  const { encodeToKTX2 } = await import('ktx2-encoder');
  const ktx2 = (bytes) => encodeToKTX2(bytes, { isUASTC: false, qualityLevel: 128, generateMipmap: true, imageDecoder: async () => boxTex });
  put('gltf/box.glb', box);
  put('gltf/box-draco.glb', await compressGlb(box, { draco: dracoEnc }));
  put('gltf/box-ktx2.glb', await compressGlb(box, { ktx2 }));
  put('gltf/box-draco-ktx2.glb', await compressGlb(box, { draco: dracoEnc, ktx2 }));
  for (const f of ['box.glb', 'box-draco.glb', 'box-ktx2.glb', 'box-draco-ktx2.glb']) truth.gltf[f] = { triangles: 12, vertices: 24, extensions: readGlb(new Uint8Array(readFileSync(join(outDir, 'gltf', f)))).json.extensionsUsed ?? [] };
  // b3dm with Draco + KTX2 content inside a one-tile tileset (3D Tiles content decode path).
  put('gltf/draco-ktx2.b3dm', writeB3dm(await compressGlb(box, { draco: dracoEnc, ktx2 }), { rtc: geoToEcef(O.lat, O.lon, O.h + 2) }));

  // ---- .3tz of the octree (the writer's archive form) ----
  put('implicit-octree.3tz', write3tz(oct.files, (b) => new Uint8Array(createHash('md5').update(b).digest())));

  // ---- quantized-mesh 4326 and 3857 from the Rust writer ----
  const enc = await tilesBundle();
  if (enc) {
    const b = { west: -105.05, south: 39.7, east: -104.95, north: 39.78 };
    const dem = (lat, lon) => 1600 + 120 * Math.sin((lon + 105) * 60) * Math.cos((lat - 39.74) * 70);
    for (const mercator of [false, true]) {
      const r = await writeQuantizedMesh(dem, enc, { bounds: b, mercator, maxZoom: mercator ? 12 : 11, size: 33, maxError: 0.5, normals: true, name: `fx21-${mercator ? 3857 : 4326}` });
      const dir = `qmesh-${mercator ? 3857 : 4326}`;
      for (const [k, v] of Object.entries(r.files)) put(`${dir}/${k}`, v);
      truth.qmesh[dir] = { tiles: r.tiles, maxzoom: r.layer.maxzoom, projection: r.layer.projection, available: r.layer.available, heightRange: [1600 - 120, 1600 + 120] };
    }
  } else truth.qmesh.skipped = 'the tiles bundle is not built (cargo build in CARGO_TARGET_DIR)';
  put('truth.json', te.encode(JSON.stringify(truth, null, 1)));
  return made;
}
