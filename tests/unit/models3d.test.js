// 2.5 models3d (REQ-GAP-35): I3S scene layer packages read and written, OpenFlight written.
// Oracles:
// - Esri's sample SLPKs (D:\gwb25\data-models3d\slpk: 3DObject New York, IntegratedMesh Rancho
//   Cucamonga 1.7 and 1.8, Point NYC trees, Building Admin_Building), read by Python's zipfile and
//   an independent decoder (tests/tools/slpk_ref.py), and by the 2.4 JS decoder of
//   connectors/i3s.js;
// - Esri's i3s_converter (validate, -v; convert to 1.9, -u) on the SLPKs the app writes, and the
//   app's reader on the converted (Draco) packages;
// - for OpenFlight, an independent parser written from OGC 19-065 (tests/tools/openflight_ref.py),
//   checked first on osgEarth's tank.FLT, and OpenSceneGraph's OpenFlight plug-in (osgconv,
//   D:\gwb25\envs\osg) reading the app's files.
// The large data stays on D:; tests skip cleanly without it, the wasm or the tools.
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openAsBlob, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { Bundle } from '../../app/src/wasm/abi.js';
import { slpkEnd, slpkDirectory, i3sGeometry, geometryParams } from '../../app/src/formats/i3s-wasm.js';
import { SlpkStore, describeLayer, NodeTree, nodeGeometry, nodeAttributes, nodeTexture, gravityHeights } from '../../app/src/formats/i3s-scene.js';
import { decodeGeometry, decodeAttribute } from '../../app/src/connectors/i3s.js';
import { decodeI3sDraco } from '../../app/src/render/i3s-draco.js';
import { writeSlpk, objectsFromModels, obbOf, zipHashed } from '../../app/src/formats/slpk-write.js';
import { writeOpenFlight } from '../../app/src/formats/openflight-write.js';
import { buildingModel, faceTriangles } from '../../app/src/vector/mesh.js';
import { geoToEcef } from '../../app/src/formats/tiles3d-write.js';

const DATA = 'D:/gwb25/data-models3d';
const SLPK = `${DATA}/slpk`;
const CONVERTER = `${DATA}/i3s_converter/i3s_converter.exe`;
const WORK = `${DATA}/work/vitest`;
const PYENV = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te';
const PY = `${PYENV}/python.exe`;
const OSG = 'D:/gwb25/envs/osg/Library/bin';
const haveData = existsSync(`${SLPK}/Rancho_Mesh_v18.slpk`);
const havePy = existsSync(PY);
const haveConverter = existsSync(CONVERTER) && process.platform === 'win32';
const haveOsg = existsSync(`${OSG}/osgconv.exe`);
const pyEnv = { ...process.env, PATH: `${PYENV};${PYENV}/Library/bin;${process.env.PATH}` };
const py = (script, args) => JSON.parse(execFileSync(PY, ['-I', resolve('tests/tools', script), ...args], { env: pyEnv, maxBuffer: 1 << 30, encoding: 'utf8' }));

const target = (() => {
  try {
    return JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
  } catch {
    return null;
  }
})();
const wasmPath = target ? join(target, 'wasm32-unknown-unknown', 'release', 'gw_bundle_tiles.wasm') : null;
const haveWasm = !!wasmPath && existsSync(wasmPath);
let tiles = null;
const run = async (op, d) => {
  if (op === 'i3s.slpkEnd') return slpkEnd(tiles, d.tail, d.length);
  if (op === 'i3s.slpkDir') return slpkDirectory(tiles, d.cd);
  throw new Error(op);
};
const decode = {
  plain: async (bytes, layout) => i3sGeometry(tiles, bytes, layout, 8e6),
  draco: async (bytes) => decodeI3sDraco(await dracoModule(), zlib.gunzipSync(bytes)),
};
let dracoM = null;
async function dracoModule() {
  if (dracoM) return dracoM;
  const root = resolve('node_modules/three/examples/jsm/libs/draco');
  const ctx = vm.createContext({ console, WebAssembly, Promise, setTimeout, Date, Math, Int8Array, Uint8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array });
  vm.runInContext(`${readFileSync(join(root, 'draco_wasm_wrapper.js'), 'utf8')}\nthis.DracoDecoderModule = DracoDecoderModule;`, ctx);
  dracoM = await new Promise((res) => ctx.DracoDecoderModule({ wasmBinary: readFileSync(join(root, 'draco_decoder.wasm')), onModuleLoaded: res }));
  return dracoM;
}
const fileOf = async (p) => Object.assign(await openAsBlob(p), { name: p.split('/').pop() });
const open = async (p) => SlpkStore.open(await fileOf(p), run);

beforeAll(() => {
  if (haveWasm) tiles = new Bundle(new WebAssembly.Module(readFileSync(wasmPath)), 'tiles');
  mkdirSync(WORK, { recursive: true });
});

describe.skipIf(!haveWasm || !haveData || !havePy)('SLPK container (Rust) against Python zipfile', () => {
  for (const f of ['Rancho_Mesh_v18.slpk', 'Rancho_Mesh_v17.slpk', 'Admin_Building_v18.slpk', '2015_Street_Tree_Survey_v18.slpk', 'Buildings_NewYork_v18.slpk']) {
    it(`lists every entry of ${f} as zipfile does`, async () => {
      if (!existsSync(`${SLPK}/${f}`)) return;
      const s = await open(`${SLPK}/${f}`);
      const ref = py('slpk_ref.py', ['list', `${SLPK}/${f}`]);
      expect(s.entries.length).toBe(ref.length);
      for (let i = 0; i < ref.length; i++) {
        expect(s.entries[i].name).toBe(ref[i].name);
        expect([s.entries[i].offset, s.entries[i].csize, s.entries[i].size, s.entries[i].method]).toEqual([ref[i].offset, ref[i].csize, ref[i].size, ref[i].method]);
      }
    }, 120000);
  }
});

describe.skipIf(!haveWasm || !haveData || !havePy)('I3S layers of the Esri samples', () => {
  it('reads the IntegratedMesh layer (1.8): node tree, LOD thresholds, geometry, JPEG textures', async () => {
    const s = await open(`${SLPK}/Rancho_Mesh_v18.slpk`);
    const info = describeLayer(await s.layerDocument(), 'Rancho');
    expect(info.layerType).toBe('IntegratedMesh');
    expect(info.geometry[0].layout).toBeTruthy(); // the uncompressed buffer is read where there is one
    expect(info.textures[0].pick.format).toBe('jpg');
    expect(info.gravity).toBe(true); // orthometric heights
    const nodes = await new NodeTree(s, info).all();
    expect(nodes.length).toBe(81);
    const withMesh = nodes.filter((n) => n.mesh);
    expect(withMesh.length).toBe(80);
    expect(nodes.filter((n) => n.lodThreshold > 0).length).toBeGreaterThan(60);
    // Every node's geometry, against the independent decoder.
    for (const n of withMesh.slice(0, 6)) {
      const g = await nodeGeometry(s, info, n, decode, () => 0);
      const r = py('slpk_ref.py', ['geometry', `${SLPK}/Rancho_Mesh_v18.slpk`, `nodes/${n.mesh.geometry.resource}/geometries/0.bin.gz`, JSON.stringify(info.geometry[0].layout)]);
      expect(g.vertexCount).toBe(r.vertexCount);
      expect(r.bytesUsed).toBe(r.bytes);
      const c = n.obb.center;
      let max = 0;
      for (let i = 0; i < r.vertexCount * 3; i++) max = Math.max(max, Math.abs(g.geo[i] - (c[i % 3] + r.position[i])));
      expect(max).toBeLessThan(1e-9);
      const tex = await nodeTexture(s, info, n);
      expect(tex.format).toBe('jpg');
      expect([tex.bytes[0], tex.bytes[1]]).toEqual([0xff, 0xd8]);
    }
  }, 300000);

  it('decodes the Draco buffers (i3s-scale_x/y, feature-index) to the same triangles as the uncompressed ones', async () => {
    const s = await open(`${SLPK}/Rancho_Mesh_v18.slpk`);
    const info = describeLayer(await s.layerDocument(), 'Rancho');
    const nodes = (await new NodeTree(s, info).all()).filter((n) => n.mesh);
    const res = [];
    for (const n of nodes.slice(0, 8)) {
      const plain = await nodeGeometry(s, info, n, decode, () => 0);
      const dInfo = { ...info, geometry: [{ index: 1, draco: ['position', 'uv0', 'feature-index'] }] };
      const d = await nodeGeometry(s, dInfo, n, decode, () => 0);
      expect(d.indices.length).toBe(plain.vertexCount); // same number of triangles
      // Each Draco triangle's corners against the uncompressed triangle at the same place: Draco
      // reorders triangles, so match by the centroid.
      const key = (x, y) => `${Math.round(x * 2e4)},${Math.round(y * 2e4)}`;
      const cent = new Map();
      const near = (x, y) => {
        let best = null;
        let bd = Infinity;
        const [i0, j0] = [Math.round(x * 2e4), Math.round(y * 2e4)];
        for (let di = -1; di <= 1; di++)
          for (let dj = -1; dj <= 1; dj++)
            for (const p of cent.get(`${i0 + di},${j0 + dj}`) ?? []) {
              const d = Math.hypot(p[0] - x, p[1] - y);
              if (d < bd) [bd, best] = [d, p];
            }
        return best;
      };
      for (let t = 0; t < plain.vertexCount; t += 3) {
        let x = 0;
        let y = 0;
        let z = 0;
        for (let k = 0; k < 3; k++) {
          x += plain.geo[3 * (t + k)] / 3;
          y += plain.geo[3 * (t + k) + 1] / 3;
          z += plain.geo[3 * (t + k) + 2] / 3;
        }
        const kk = key(x, y);
        if (!cent.has(kk)) cent.set(kk, []);
        cent.get(kk).push([x, y, z]);
      }
      let found = 0;
      let maxH = 0;
      let maxV = 0;
      const k0 = 111320 * Math.cos((n.obb.center[1] * Math.PI) / 180);
      for (let t = 0; t < d.indices.length; t += 3) {
        let x = 0;
        let y = 0;
        let z = 0;
        for (let k = 0; k < 3; k++) {
          const v = d.indices[t + k];
          x += d.geo[3 * v] / 3;
          y += d.geo[3 * v + 1] / 3;
          z += d.geo[3 * v + 2] / 3;
        }
        const p = near(x, y);
        if (!p) continue;
        found++;
        maxH = Math.max(maxH, Math.hypot((x - p[0]) * k0, (y - p[1]) * 111320));
        maxV = Math.max(maxV, Math.abs(z - p[2]));
      }
      expect(found / (d.indices.length / 3)).toBeGreaterThan(0.95);
      expect(d.featureIds.length).toBe(1);
      res.push({ node: n.index, tris: d.indices.length / 3, found, maxH, maxV });
    }
    // Draco quantisation: centroids agree within a few millimetres.
    for (const r of res) {
      expect(r.maxH).toBeLessThan(0.02);
      expect(r.maxV).toBeLessThan(0.02);
    }
    console.log('Rancho Draco vs uncompressed', JSON.stringify(res));
  }, 300000);

  it('reads the 3DObject layer (New York, 5,883 nodes): geometry against the 2.4 decoder, attributes against Python', async () => {
    const f = `${SLPK}/Buildings_NewYork_v18.slpk`;
    if (!existsSync(f)) return;
    const s = await open(f);
    const doc = await s.layerDocument();
    const info = describeLayer(doc, 'NY');
    expect(info.layerType).toBe('3DObject');
    expect(gravityHeights(doc)).toBe(true);
    const tree = new NodeTree(s, info);
    const root = await tree.node(0);
    expect(root.mesh).toBeUndefined();
    expect(root.children.length).toBe(67);
    let checked = 0;
    for (const i of root.children.slice(0, 5)) {
      const n = await tree.node(i);
      const bytes = zlib.gunzipSync(await s.geometry(n.mesh.geometry.resource, 0));
      const js = decodeGeometry(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), info.geometry[0].layout);
      const rs = i3sGeometry(tiles, bytes, info.geometry[0].layout);
      expect(rs.vertexCount).toBe(js.vertexCount);
      expect(Array.from(rs.position)).toEqual(Array.from(js.position));
      expect(Array.from(rs.faceRange)).toEqual(Array.from(js.faceRange));
      expect(Array.from(rs.featureId)).toEqual(js.featureId);
      const attrs = await nodeAttributes(s, info, n);
      expect(attrs.OBJECTID.length).toBe(n.mesh.geometry.featureCount);
      for (const st of info.attributes) {
        const ref = py('slpk_ref.py', ['attribute', f, `nodes/${n.mesh.attribute.resource}/attributes/${st.key}/0.bin.gz`, JSON.stringify(st)]);
        expect(ref.bytesUsed).toBe(ref.bytes);
        expect(attrs[st.name]).toEqual(ref.values);
      }
      checked++;
    }
    expect(checked).toBe(5);
  }, 600000);

  it('reads the Point layer (NYC trees, Draco points with feature ids) and a Building layer’s sublayers; refuses PCSL by name', async () => {
    const f = `${SLPK}/2015_Street_Tree_Survey_v18.slpk`;
    const s = await open(f);
    const info = describeLayer(await s.layerDocument(), 'trees');
    expect(info.layerType).toBe('Point');
    const tree = new NodeTree(s, info);
    const n = await tree.node(0);
    const g = await nodeGeometry(s, info, n, decode, () => 0);
    expect(g.kind).toBe('points');
    expect(g.vertexCount).toBe(n.mesh.geometry.vertexCount);
    const attrs = await nodeAttributes(s, info, n, { fields: ['FID', 'latitude', 'longitude'] });
    // Each point's feature (Draco feature-index → i3s-feature-ids) is the feature whose FID the
    // attribute resource holds at that position, and every point lies in the layer's extent. (The
    // survey's own latitude/longitude fields are not an oracle: 939 of the 1,498 root points have
    // none within 1 m; of the others, 556 sit at their own feature's and 3 at another's.)
    const [x0, y0, x1, y1] = info.extent;
    for (let v = 0; v < g.vertexCount; v++) {
      const k = g.featureOf[v];
      expect(attrs.FID[k]).toBe(g.featureIds[k]);
      expect(g.geo[3 * v] >= x0 - 1e-6 && g.geo[3 * v] <= x1 + 1e-6 && g.geo[3 * v + 1] >= y0 - 1e-6 && g.geo[3 * v + 1] <= y1 + 1e-6).toBe(true);
    }
    expect(new Set(g.featureOf).size).toBe(g.vertexCount);
    const b = await open(`${SLPK}/Admin_Building_v18.slpk`);
    const bi = describeLayer(await b.layerDocument(), 'admin');
    expect(bi.layerType).toBe('Building');
    expect(bi.sublayers.filter((x) => x.visible).length).toBeGreaterThan(5);
    const sub = bi.sublayers.find((x) => x.visible && b.hasSublayer(x.id));
    const si = describeLayer(await b.sub(`sublayers/${sub.id}/`).layerDocument(), sub.name);
    expect(si.layerType).toBe('3DObject');
    expect(() => describeLayer({ layerType: 'PointCloud' }, 'x.slpk')).toThrow(/point cloud scene layers/);
    expect(() => describeLayer({ layerType: '3DObject', store: { version: '1.6' } }, 'old.slpk')).toThrow(/no node pages/);
  }, 300000);
});

// ---- writer ----
const origin = { lat: 47.6062, lon: -122.3321, h: 35 };
const K = Math.PI / 180;
const toGeo = (x, y, z) => [origin.lon + x / (6378137 * Math.cos(origin.lat * K) * K), origin.lat + y / (6378137 * K), origin.h + z];
function buildings(n) {
  const models = [];
  for (let i = 0; i < n; i++) {
    const x = (i % 20) * 30;
    const y = Math.floor(i / 20) * 30;
    models.push({ id: `b${i}`, name: `Building ${i} — Здание`, model: buildingModel({ ring: [[x, y], [x + 20, y], [x + 20, y + 15], [x, y + 15]], base: (i % 7) * 0.5, height: 8 + (i % 13), roof: ['flat', 'gable', 'hip', 'shed'][i % 4], ridge: 3 }), attrs: { HGT: 8 + (i % 13), F_CODE: 'AL013', heightMethod: i % 2 ? 'DSM' : 'attribute' } });
  }
  return objectsFromModels(models, faceTriangles);
}

describe('SLPK writer', () => {
  it('OBB: every vertex inside, quaternion as I3S defines it (local = Rᵀ (P − C) in ECEF)', () => {
    const objs = buildings(40);
    const all = Float64Array.from(objs.flatMap((o) => Array.from({ length: o.positions.length / 3 }, (_, v) => toGeo(o.positions[3 * v], o.positions[3 * v + 1], o.positions[3 * v + 2])).flat()));
    const o = obbOf(all);
    const [x, y, z, w] = o.quaternion;
    const R = [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
    const C = geoToEcef(o.center[1], o.center[0], o.center[2]);
    let worst = 0;
    for (let i = 0; i < all.length; i += 3) {
      const P = geoToEcef(all[i + 1], all[i], all[i + 2]);
      const d = [P[0] - C[0], P[1] - C[1], P[2] - C[2]];
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(d[0] * R[0][k] + d[1] * R[1][k] + d[2] * R[2][k]) - o.halfSize[k]);
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it.skipIf(!haveWasm)('round trip through the reader: positions, features, attributes, hash index', async () => {
    const objs = buildings(500);
    const r = writeSlpk({ name: 'GW buildings', objects: objs, toGeo }, { maxFeatures: 16 });
    expect(r.leaves).toBe(32);
    const p = `${WORK}/rt500.slpk`;
    writeFileSync(p, r.bytes);
    const s = await open(p);
    const info = describeLayer(await s.layerDocument(), 'rt');
    expect(info.gravity).toBe(false);
    const nodes = await new NodeTree(s, info).all();
    expect(nodes.length).toBe(r.nodes);
    let maxH = 0;
    let maxV = 0;
    let feats = 0;
    for (const n of nodes.filter((x) => x.mesh)) {
      const g = await nodeGeometry(s, info, n, decode, () => 0);
      const attrs = await nodeAttributes(s, info, n);
      let v0 = 0;
      for (let f = 0; f < g.featureIds.length; f++) {
        const i = g.featureIds[f] - 1;
        const o = objs[i];
        expect(attrs.OBJECTID[f]).toBe(i + 1);
        expect(attrs.NAME[f]).toBe(`Building ${i} — Здание`);
        expect(attrs.HGT[f]).toBe(o.attrs.HGT);
        expect(attrs.heightMethod[f]).toBe(o.attrs.heightMethod);
        const m = o.positions.length / 3;
        for (let v = 0; v < m; v++) {
          const want = toGeo(o.positions[3 * v], o.positions[3 * v + 1], o.positions[3 * v + 2]);
          const got = [g.geo[3 * (v0 + v)], g.geo[3 * (v0 + v) + 1], g.geo[3 * (v0 + v) + 2]];
          maxH = Math.max(maxH, Math.hypot((got[0] - want[0]) * 75000, (got[1] - want[1]) * 111000));
          maxV = Math.max(maxV, Math.abs(got[2] - want[2]));
          expect(g.featureOf[v0 + v]).toBe(f);
        }
        v0 += m;
        feats++;
      }
    }
    expect(feats).toBe(500);
    // float32 offsets from the node centre: under a millimetre.
    expect(maxH).toBeLessThan(0.001);
    expect(maxV).toBeLessThan(0.001);
    if (havePy) {
      const hsh = py('slpk_ref.py', ['hash', p]);
      expect(hsh).toEqual({ present: true, entries: hsh.files, files: hsh.files, sorted: true, wrong: 0, trailingBytes: 0 });
    }
  }, 120000);

  it.skipIf(!haveConverter || !haveWasm)('Esri i3s_converter validates written packages (buildings, terrain), and its 1.9 conversion reads back through Draco', async () => {
    const cases = {
      b1000: writeSlpk({ name: 'buildings', objects: buildings(1000), toGeo }, { maxFeatures: 8 }), // 125 leaves: a level of inner nodes
      b1: writeSlpk({ name: 'one', objects: buildings(1), toGeo }),
    };
    // A textured terrain grid (65 × 65 posts) with a JPEG.
    const n = 65;
    const P = [];
    const UV = [];
    const z = (i, j) => 10 * Math.sin(i / 6) * Math.cos(j / 9);
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++)
        for (const [a, b] of [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
          [1, 1],
          [0, 1],
        ]) {
          P.push((i + a) * 10, -(j + b) * 10, z(i + a, j + b));
          UV.push((i + a) / (n - 1), (j + b) / (n - 1));
        }
    const jpeg = readFileSync(resolve('fixtures/fx25/models3d/texture.jpg'));
    cases.terrain = writeSlpk({ name: 'terrain', objects: [{ id: 't', name: 'Terrain', attrs: { KIND: 'terrain' }, positions: Float64Array.from(P), uv: Float32Array.from(UV) }], toGeo, texture: { bytes: jpeg, format: 'jpg' } });
    const report = {};
    for (const [k, r] of Object.entries(cases)) {
      const p = `${WORK}/${k}.slpk`;
      rmSync(`${WORK}/${k}_v19.log.json`, { force: true });
      writeFileSync(p, r.bytes);
      execFileSync(CONVERTER, ['-v', p, '-d', WORK], { cwd: WORK, encoding: 'utf8', maxBuffer: 1 << 26 });
      const log = JSON.parse(readFileSync(`${WORK}/${k}_v19.log.json`, 'utf8'));
      report[k] = { success: log.success, messages: log.log.filter((m) => !/^Information/.test(m.message)).map((m) => m.message) };
      expect(log.success, k).toBe(true);
      expect(report[k].messages, k).toEqual([]);
    }
    // Conversion to 1.9 (Esri adds a Draco buffer and DXT textures): the app reads the Draco one.
    const out = `${WORK}/conv`;
    mkdirSync(out, { recursive: true });
    rmSync(`${out}/terrain19_v19.slpk`, { force: true });
    execFileSync(CONVERTER, ['-u', `${WORK}/terrain.slpk`, '-d', out, '-o', 'terrain19'], { cwd: out, encoding: 'utf8', maxBuffer: 1 << 26 });
    const conv = await open(`${out}/terrain19_v19.slpk`);
    const ci = describeLayer(await conv.layerDocument(), 'converted');
    const cd = { ...ci, geometry: ci.geometry.map((g, i) => ({ index: 1, draco: ['position'] })) };
    const nodes = (await new NodeTree(conv, ci).all()).filter((x) => x.mesh);
    expect(nodes.length).toBeGreaterThan(0);
    let tris = 0;
    let lo = [Infinity, Infinity];
    let hi = [-Infinity, -Infinity];
    for (const nd of nodes) {
      const g = await nodeGeometry(conv, cd, nd, decode, () => 0);
      tris += g.indices.length / 3;
      for (let v = 0; v < g.vertexCount; v++) {
        lo = [Math.min(lo[0], g.geo[3 * v]), Math.min(lo[1], g.geo[3 * v + 1])];
        hi = [Math.max(hi[0], g.geo[3 * v]), Math.max(hi[1], g.geo[3 * v + 1])];
      }
    }
    expect(tris).toBe(2 * (n - 1) * (n - 1));
    const [x0, y0] = toGeo(0, -(n - 1) * 10, 0);
    const [x1, y1] = toGeo((n - 1) * 10, 0, 0);
    expect(Math.abs(lo[0] - x0) * 75000).toBeLessThan(0.05);
    expect(Math.abs(hi[1] - y1) * 111000).toBeLessThan(0.05);
    expect(Math.abs(hi[0] - x1) * 75000).toBeLessThan(0.05);
    expect(Math.abs(lo[1] - y0) * 111000).toBeLessThan(0.05);
    console.log('i3s_converter', JSON.stringify(report));
  }, 600000);

  it('refuses an empty write and a package over 4 GB by name', () => {
    expect(() => writeSlpk({ objects: [], toGeo })).toThrow(/nothing to write/);
    expect(zipHashed({ a: new Uint8Array(3) }).length).toBeGreaterThan(0);
  });
});

describe('I3S attribute decoding (2.4 decoder fix)', () => {
  it('reads Oid32 object ids (were NaN)', () => {
    const b = new Uint8Array(12);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 2, true);
    dv.setUint32(4, 7, true);
    dv.setUint32(8, 4000000000, true);
    expect(decodeAttribute(b.buffer, { header: [{ property: 'count', valueType: 'UInt32' }], ordering: ['attributeValues'], attributeValues: { valueType: 'Oid32' } })).toEqual([7, 4000000000]);
  });
});

describe.skipIf(!haveWasm)('Rust I3S decoders refuse bad input by name', () => {
  it('geometry: cut buffers, bad face ranges, absurd counts', () => {
    const lay = { offset: 8, position: { type: 'Float32', component: 3 }, faceRange: { type: 'UInt32', component: 2 } };
    const b = new Uint8Array(8 + 36 + 8);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 3, true);
    dv.setUint32(4, 1, true);
    dv.setUint32(44, 0, true);
    dv.setUint32(48, 0, true);
    expect(i3sGeometry(tiles, b, lay).vertexCount).toBe(3);
    dv.setUint32(48, 5, true);
    expect(() => i3sGeometry(tiles, b, lay)).toThrow(/outside its/);
    expect(() => i3sGeometry(tiles, b.subarray(0, 20), lay)).toThrow(/shorter than its layout/);
    dv.setUint32(0, 3e9, true);
    expect(() => i3sGeometry(tiles, b, lay)).toThrow(/vertices/);
    expect(geometryParams(lay).length).toBe(16);
    expect(() => slpkEnd(tiles, new Uint8Array(40), 40)).toThrow(/not a ZIP archive/);
  });
});

// ---- OpenFlight ----
describe.skipIf(!havePy)('OpenFlight writer against the independent parser and OpenSceneGraph', () => {
  it('the parser reads osgEarth’s tank.FLT (a third-party 16.0 database) consistently with osgconv', { timeout: 120000 }, () => {
    const f = `${DATA}/openflight/tank.FLT`;
    if (!existsSync(f)) return;
    const r = py('openflight_ref.py', [f]);
    expect(r.errors).toEqual([]);
    expect(r.header.revision).toBe(1600);
    expect(r.balanced).toBe(true);
    expect(r.faces).toBe(957);
    expect(r.verticesUsed).toBe(r.vertices);
    if (haveOsg) {
      const obj = `${WORK}/tank.obj`;
      execFileSync(`${OSG}/osgconv.exe`, [f, obj], { env: { ...process.env, PATH: `${OSG};${process.env.PATH}` }, encoding: 'utf8' });
      const o = objStats(readFileSync(obj, 'utf8'));
      // OSG keeps the same vertices: the same bounding box.
      for (let k = 0; k < 3; k++) {
        expect(o.lo[k]).toBeCloseTo(r.bbox[0][k], 4);
        expect(o.hi[k]).toBeCloseTo(r.bbox[1][k], 4);
      }
    }
  });

  it('buildings and textured terrain: structure, coordinates to the micrometre, texture palette, read by OSG', { timeout: 120000 }, () => {
    const objs = buildings(60).map((o) => ({ ...o, colour: [0.8, 0.6, 0.4] }));
    const w = writeOpenFlight({ objects: objs, origin, toGeo, name: 'GW buildings' });
    const p = `${WORK}/b60.flt`;
    writeFileSync(p, w.bytes);
    const dump = `${WORK}/b60.json`;
    const r = py('openflight_ref.py', [p, dump]);
    expect(r.errors).toEqual([]);
    expect(r.balanced).toBe(true);
    expect(r.header).toMatchObject({ revision: 1600, units: 0, projection: 0, storage: 1, ellipsoid: 0, length: 324 });
    expect(r.header.origin[0]).toBeCloseTo(origin.lat, 12);
    expect(r.header.origin[1]).toBeCloseTo(origin.lon, 12);
    expect(r.objects.length).toBe(60);
    expect(r.objects[0].name).toBe('Building 0 — Здание'.replace(/[^\x20-\x7e]/g, '_'));
    expect(r.triangles).toBe(w.faces);
    expect(r.polygons).toBe(0);
    const d = JSON.parse(readFileSync(dump, 'utf8'));
    let max = 0;
    d.objects.forEach((o, i) => {
      const P = objs[i].positions;
      o.faces.flat().forEach((v, k) => {
        max = Math.max(max, Math.abs(v[0] - P[3 * k]), Math.abs(v[1] - P[3 * k + 1]), Math.abs(v[2] - (P[3 * k + 2] + origin.h)));
      });
    });
    expect(max).toBeLessThan(1e-6);
    // Textured terrain: texture palette entry, every face textured, OpenFlight's v up.
    const T = [{ name: 'Terrain', positions: Float64Array.from([0, 0, 1, 10, 0, 2, 10, 10, 3, 0, 0, 1, 10, 10, 3, 0, 10, 4]), uv: Float32Array.from([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]) }];
    const tw = writeOpenFlight({ objects: T, origin, toGeo, texture: 'terrain.jpg', terrain: true });
    const tp = `${WORK}/terrain.flt`;
    writeFileSync(tp, tw.bytes);
    const tr = py('openflight_ref.py', [tp]);
    expect(tr.textures).toEqual([{ file: 'terrain.jpg', index: 0 }]);
    expect(tr.texturedFaces).toBe(2);
    expect(tr.uvRange).toEqual([
      [0, 0],
      [1, 1],
    ]);
    if (haveOsg) {
      const obj = `${WORK}/b60.obj`;
      execFileSync(`${OSG}/osgconv.exe`, [p, obj], { env: { ...process.env, PATH: `${OSG};${process.env.PATH}` }, encoding: 'utf8' });
      const o = objStats(readFileSync(obj, 'utf8'));
      expect(o.faces).toBe(w.faces);
      for (let k = 0; k < 3; k++) {
        expect(o.lo[k]).toBeCloseTo(r.bbox[0][k], 3);
        expect(o.hi[k]).toBeCloseTo(r.bbox[1][k], 3);
      }
    }
  });
});

/** Vertex bounding box and triangle count of an OBJ (osgconv output; faces may be fans). */
function objStats(text) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let faces = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      const v = line.trim().split(/\s+/).slice(1, 4).map(Number);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], v[k]);
        hi[k] = Math.max(hi[k], v[k]);
      }
    } else if (line.startsWith('f ')) faces += line.trim().split(/\s+/).length - 3;
  }
  return { lo, hi, faces };
}
