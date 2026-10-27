// Mock 3D content for the E2E specs: b3dm boxes (3D Tiles) and quantized-mesh terrain tiles.

const A = 6378137;
const E2 = 0.0066943799901413165;
export const ecef = (lat, lon, h) => {
  const [la, lo] = [(lat * Math.PI) / 180, (lon * Math.PI) / 180];
  const n = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
  return [(n + h) * Math.cos(la) * Math.cos(lo), (n + h) * Math.cos(la) * Math.sin(lo), (n * (1 - E2) + h) * Math.sin(la)];
};

/** A b3dm box: (lat, lon) centre, half size in metres, height; vertices relative to RTC_CENTER. */
export function b3dmBox(lat, lon, half, h) {
  const dLat = half / 110950;
  const dLon = half / (111320 * Math.cos((lat * Math.PI) / 180));
  const corners = [];
  for (const z of [0, h]) for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) corners.push([lat + b * dLat, lon + a * dLon, z]);
  const rtc = ecef(lat, lon, 0);
  const pos = new Float32Array(corners.length * 3);
  corners.forEach(([la, lo, z], i) => {
    const p = ecef(la, lo, z);
    const [x, y, zz] = [p[0] - rtc[0], p[1] - rtc[1], p[2] - rtc[2]];
    pos.set([x, zz, -y], 3 * i); // glTF is Y-up
  });
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const mins = [0, 1, 2].map((k) => Math.min(...[...Array(8).keys()].map((i) => pos[3 * i + k])));
  const maxs = [0, 1, 2].map((k) => Math.max(...[...Array(8).keys()].map((i) => pos[3 * i + k])));
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength }], accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: mins, max: maxs }, { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' }] };
  let js = Buffer.from(JSON.stringify(gltf));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const binP = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const glb = Buffer.alloc(12 + 8 + js.length + 8 + binP.length);
  glb.write('glTF', 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(js.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  js.copy(glb, 20);
  glb.writeUInt32LE(binP.length, 20 + js.length);
  glb.writeUInt32LE(0x004e4942, 24 + js.length);
  binP.copy(glb, 28 + js.length);
  let ft = Buffer.from(JSON.stringify({ BATCH_LENGTH: 0, RTC_CENTER: rtc }));
  ft = Buffer.concat([ft, Buffer.alloc((8 - ((28 + ft.length) % 8)) % 8, 0x20)]);
  const hdr = Buffer.alloc(28);
  hdr.write('b3dm', 0);
  hdr.writeUInt32LE(1, 4);
  hdr.writeUInt32LE(28 + ft.length + glb.length, 8);
  hdr.writeUInt32LE(ft.length, 12);
  return Buffer.concat([hdr, ft, glb]);
}

const zigzag = (v) => ((v << 1) ^ (v >> 31)) & 0xffff;

/**
 * A quantized-mesh-1.0 tile: an n × n vertex grid over the tile with heights h(lat, lon), split
 * into triangles; u/v/height zig-zag delta encoded, indices high-water-mark encoded.
 */
export function qmTile({ west, south, east, north }, n, h) {
  const us = [];
  const vs = [];
  const hs = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    us.push(Math.round((i / (n - 1)) * 32767));
    vs.push(Math.round((j / (n - 1)) * 32767));
    hs.push(h(south + (j / (n - 1)) * (north - south), west + (i / (n - 1)) * (east - west)));
  }
  const minH = Math.min(...hs);
  const maxH = Math.max(...hs);
  const hq = hs.map((x) => Math.round(((x - minH) / Math.max(1e-9, maxH - minH)) * 32767));
  const tri = [];
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i;
    tri.push(a, a + 1, a + n + 1, a, a + n + 1, a + n);
  }
  // High-water-mark coding needs vertices numbered in order of first use.
  const order = [];
  const seen = new Map();
  for (const t of tri) if (!seen.has(t)) seen.set(t, order.push(t) - 1);
  [us, vs, hq].forEach((arr) => arr.splice(0, arr.length, ...order.map((k) => arr[k])));
  for (let i = 0; i < tri.length; i++) tri[i] = seen.get(tri[i]);
  const nv = n * n;
  const head = Buffer.alloc(88);
  head.writeFloatLE(minH, 24);
  head.writeFloatLE(maxH, 28);
  const vert = Buffer.alloc(4 + 6 * nv);
  vert.writeUInt32LE(nv, 0);
  [us, vs, hq].forEach((arr, k) => {
    let prev = 0;
    arr.forEach((x, i) => {
      vert.writeUInt16LE(zigzag(x - prev), 4 + 2 * (k * nv + i));
      prev = x;
    });
  });
  const pad = Buffer.alloc((88 + vert.length) % 2);
  const idx = Buffer.alloc(4 + 2 * tri.length);
  idx.writeUInt32LE(tri.length / 3, 0);
  let highest = 0;
  tri.forEach((t, i) => {
    const code = highest - t;
    idx.writeUInt16LE(code, 4 + 2 * i);
    if (code === 0) highest++;
  });
  // Edge lists (west, south, east, north) and no extensions.
  const edges = [[], [], [], []];
  for (let j = 0; j < n; j++) {
    edges[0].push(seen.get(j * n));
    edges[2].push(seen.get(j * n + n - 1));
  }
  for (let i = 0; i < n; i++) {
    edges[1].push(seen.get(i));
    edges[3].push(seen.get((n - 1) * n + i));
  }
  const eb = Buffer.concat(edges.map((e) => {
    const b = Buffer.alloc(4 + 2 * e.length);
    b.writeUInt32LE(e.length, 0);
    e.forEach((x, i) => b.writeUInt16LE(x, 4 + 2 * i));
    return b;
  }));
  return { bytes: Buffer.concat([head, vert, pad, idx, eb]), minH, maxH };
}
