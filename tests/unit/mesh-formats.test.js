// REQ-GAP-34 (REQ-EXT-29): COLLADA write + read round trip, STL and PLY write read back by three.js's
// STLLoader and PLYLoader (independent readers), KMZ with a KML Model, and the COLLADA reader on
// hand-written documents (Y_UP, units, node transforms, polylist, polygons, instance_node).
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { buildingModel } from '../../app/src/vector/mesh.js';
import { writeCollada, readCollada, writeStl, writePly, writeKmz, kmlModel, parseXml, modelTriangles, colladaToGlb } from '../../app/src/vector/mesh-formats.js';
import { terrainGrid, uvLookup } from '../../app/src/hub/terrain3d.js';

const origin = { lat: 36.2418, lon: -115.2854, h: 612.5 };
// An L-shaped (concave) flat building, a gable and a hip roof: 3 models, 33 faces.
const models = [
  { id: 'b1', name: 'L block', model: buildingModel({ ring: [[0, 0], [30, 0], [30, 10], [10, 10], [10, 25], [0, 25]], base: 0, height: 12 }), attrs: { HGT: 12, F_CODE: 'AL013' } },
  { id: 'b2', name: 'Gable', model: buildingModel({ ring: [[40, 0], [60, 0], [60, 12], [40, 12]], base: 1.5, height: 6, roof: 'gable', ridge: 3 }), attrs: { HGT: 9 } },
  { id: 'b3', name: 'Hip', model: buildingModel({ ring: [[70, 5], [90, 5], [90, 17], [70, 17]], base: 0.5, height: 5, roof: 'hip', ridge: 2.5 }), attrs: {} },
];

/** Triangles as coordinate triples, the summed area and the enclosed volume (divergence theorem). */
function measure(ms) {
  let area = 0;
  let vol = 0;
  const tris = [];
  for (const m of ms) {
    const V = m.model.vertices;
    for (const [a, b, c] of modelTriangles(m.model)) {
      const [p, q, r] = [V[a], V[b], V[c]];
      tris.push([p, q, r]);
      const u = q.map((x, k) => x - p[k]);
      const v = r.map((x, k) => x - p[k]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      area += Math.hypot(...n) / 2;
      vol += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    }
  }
  return { tris, area, vol };
}
const exactVolume = 30 * 10 * 12 + 10 * 15 * 12 + (20 * 12 * 6 + 0.5 * 12 * 3 * 20) + (20 * 12 * 5 + (12 * 2.5 * (20 - 12)) / 2 + (2 * 12 * 6 * 2.5) / 3);

describe('COLLADA writer and reader', () => {
  it('writes a schema-shaped 1.4.1 document: Z_UP metres, a geometry and a node per model, the origin extra', () => {
    const dae = writeCollada(models, origin, { created: '2026-11-02T00:00:00Z' });
    const x = parseXml(dae);
    const root = x.children.find((c) => c.name === 'COLLADA');
    expect(root.attrs.version).toBe('1.4.1');
    expect(dae).toContain('<up_axis>Z_UP</up_axis>');
    expect(dae).toContain('<unit name="meter" meter="1"/>');
    expect((dae.match(/<geometry /g) ?? []).length).toBe(3);
    expect((dae.match(/<node /g) ?? []).length).toBe(3);
    // Element order inside <COLLADA> follows the 1.4.1 schema sequence.
    const order = root.children.map((c) => c.name);
    expect(order).toEqual(['asset', 'library_effects', 'library_materials', 'library_geometries', 'library_visual_scenes', 'scene', 'extra']);
  });

  it('reads back what it wrote: same triangles to 0.1 mm, same area and volume, origin and attributes', () => {
    const before = measure(models);
    const doc = readCollada(writeCollada(models, origin));
    expect(doc.models.map((m) => m.name)).toEqual(['L block', 'Gable', 'Hip']);
    expect(doc.origin).toEqual(origin);
    expect(doc.models[0].attrs).toEqual({ HGT: '12', F_CODE: 'AL013' });
    const after = measure(doc.models);
    expect(after.tris.length).toBe(before.tris.length);
    let worst = 0;
    after.tris.forEach((t, i) => t.forEach((p, k) => p.forEach((x, a) => (worst = Math.max(worst, Math.abs(x - before.tris[i][k][a]))))));
    expect(worst).toBeLessThan(1e-4);
    expect(after.area).toBeCloseTo(before.area, 3);
    expect(after.vol).toBeCloseTo(before.vol, 3);
    expect(before.vol).toBeCloseTo(exactVolume, 6); // closed, outward-wound solids
  });

  it('carries a texture: image, effect sampler chain and per-vertex coordinates (t = 1 − v)', () => {
    const grid = terrainGrid(5, (i, j) => ({ lat: 36.24 + j * 1e-4, lon: -115.28 + i * 1e-4, h: 600 + i + j, u: i / 4, v: j / 4 }));
    const tex = { png: new Uint8Array([137, 80, 78, 71]), uv: uvLookup(grid), name: 'terrain.png' };
    const doc = readCollada(writeCollada([{ id: 't', name: 'Terrain', model: grid }], grid.origin, { texture: tex }));
    expect(doc.images).toEqual([{ id: 'tex0', path: 'terrain.png' }]);
    const m = doc.models[0];
    expect(m.image).toBe('terrain.png');
    m.model.vertices.forEach((v, i) => expect(m.uvs[i][0]).toBeCloseTo(uvLookup(grid)(...v)[0], 6));
    m.model.vertices.forEach((v, i) => expect(m.uvs[i][1]).toBeCloseTo(uvLookup(grid)(...v)[1], 6));
    // Into a GLB for the 3D view, texture kept.
    const g = colladaToGlb(doc, { images: new Map([['terrain.png', tex.png]]) });
    expect(g.textured).toBe(true);
    const json = JSON.parse(new TextDecoder().decode(g.glb.subarray(20, 20 + new DataView(g.glb.buffer).getUint32(12, true))));
    expect(json.asset.extras.origin.lat).toBeCloseTo(grid.origin.lat, 9);
    expect(json.images[0].mimeType).toBe('image/png');
  });

  it('reads other writers: Y_UP, centimetres, matrix / translate / rotate / scale, polylist, polygons, instance_node', () => {
    const dae = `<?xml version="1.0"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
 <asset><unit name="centimeter" meter="0.01"/><up_axis>Y_UP</up_axis></asset>
 <library_geometries>
  <geometry id="sq"><mesh>
   <source id="p"><float_array id="pa" count="12">0 0 0 100 0 0 100 0 -100 0 0 -100</float_array>
    <technique_common><accessor source="#pa" count="4" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
   <vertices id="v"><input semantic="POSITION" source="#p"/></vertices>
   <polylist count="1"><input semantic="VERTEX" source="#v" offset="0"/><vcount>4</vcount><p>0 1 2 3</p></polylist>
  </mesh></geometry>
  <geometry id="tri"><mesh>
   <source id="p2"><float_array id="pa2" count="9">0 0 0 100 0 0 0 100 0</float_array>
    <technique_common><accessor source="#pa2" count="3" stride="3"/></technique_common></source>
   <vertices id="v2"><input semantic="POSITION" source="#p2"/></vertices>
   <polygons count="1"><input semantic="VERTEX" source="#v2" offset="0"/><p>0 1 2</p></polygons>
  </mesh></geometry>
 </library_geometries>
 <library_nodes><node id="lib"><translate>0 0 500</translate><instance_geometry url="#tri"/></node></library_nodes>
 <library_visual_scenes><visual_scene id="s">
  <node id="a" name="A"><translate>1000 0 0</translate><instance_geometry url="#sq"/></node>
  <node id="b" name="B"><matrix>1 0 0 0 0 1 0 200 0 0 1 0 0 0 0 1</matrix><rotate>0 1 0 90</rotate><scale>2 2 2</scale>
    <instance_node url="#lib"/></node>
 </visual_scene></library_visual_scenes>
 <scene><instance_visual_scene url="#s"/></scene>
</COLLADA>`;
    const doc = readCollada(dae);
    expect(doc.unit).toBe(0.01);
    expect(doc.upAxis).toBe('Y_UP');
    const [a, b] = doc.models;
    expect(a.model.faces.length).toBe(2); // the quad as a fan
    // Square in the Y_UP x–z plane, z = −100 cm → north 1 m; moved 10 m east.
    const close = (p, q) => p.forEach((x, k) => expect(x).toBeCloseTo(q[k], 9));
    close(a.model.vertices[0], [10, 0, 0]);
    close(a.model.vertices[2], [11, 1, 0]);
    // B: translate y +2 m, rotate 90° about y, scale 2, then the library node's +5 m in z (Y_UP).
    // Library vertex (100, 0, 0) cm → +z 500: (1, 0, 5) m → scale (2, 0, 10) → rot y 90°: (10, 0, −2) → +y 2: (10, 2, −2) → Z_UP (10, 2, 2).
    close(b.model.vertices[1], [10, 2, 2]);
  });

  it('refuses what is not COLLADA, with a reason', () => {
    expect(() => readCollada('<kml/>')).toThrow(/not a COLLADA document/);
    expect(() => readCollada('<COLLADA><asset></COLLADA>')).toThrow(/malformed XML/);
  });
});

describe('STL and PLY writers, read back by three.js', () => {
  const toAb = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  it('binary and ASCII STL: STLLoader reads every triangle at float precision, normals outward', () => {
    const { tris } = measure(models);
    for (const binary of [true, false]) {
      const out = writeStl(models, origin, { binary });
      const g = new STLLoader().parse(binary ? toAb(out) : out);
      const pos = g.getAttribute('position');
      expect(pos.count).toBe(tris.length * 3);
      let worst = 0;
      tris.forEach((t, i) => t.forEach((p, k) => p.forEach((x, a) => (worst = Math.max(worst, Math.abs(pos.getComponent(3 * i + k, a) - x))))));
      expect(worst).toBeLessThan(binary ? 1e-5 : 1e-5);
      // The roof's normal points up.
      const nz = g.getAttribute('normal');
      let up = 0;
      for (let i = 0; i < nz.count; i++) if (nz.getZ(i) > 0.99) up++;
      expect(up).toBeGreaterThan(0);
    }
    expect(strFromU8(writeStl(models, origin).subarray(0, 5))).not.toBe('solid');
  });

  it('binary and ASCII PLY: PLYLoader reads vertices, faces and texture coordinates', () => {
    const { tris } = measure(models);
    const nV = models.reduce((s, m) => s + m.model.vertices.length, 0);
    for (const binary of [true, false]) {
      const out = writePly(models, origin, { binary });
      const g = new PLYLoader().parse(binary ? toAb(out) : out);
      expect(g.getAttribute('position').count).toBe(nV);
      expect(g.index.count).toBe(tris.length * 3);
      const p = g.getAttribute('position');
      const i0 = g.index.getX(0);
      const [a] = tris[0];
      expect([p.getX(i0), p.getY(i0), p.getZ(i0)].map((x, k) => Math.abs(x - a[k]) < 1e-4)).toEqual([true, true, true]);
    }
    const grid = terrainGrid(4, (i, j) => ({ lat: 36.24 + j * 1e-4, lon: -115.28 + i * 1e-4, h: 600, u: i / 3, v: j / 3 }));
    const g = new PLYLoader().parse(toAb(writePly([{ id: 't', model: grid }], grid.origin, { texture: { uv: uvLookup(grid), name: 'x.png' } })));
    const uv = g.getAttribute('uv');
    expect(uv.count).toBe(16);
    expect(uv.getY(0)).toBeCloseTo(1, 6); // top-left texel, t up
  });
});

describe('KMZ with a model', () => {
  it('doc.kml places the COLLADA model at the origin with a mean-sea-level altitude; the texture travels beside it', () => {
    const grid = terrainGrid(4, (i, j) => ({ lat: 36.24 + j * 1e-4, lon: -115.28 + i * 1e-4, h: 600, u: i / 3, v: j / 3 }));
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const kmz = writeKmz([{ id: 't', name: 'Terrain', model: grid }], grid.origin, { altitude: grid.origin.h - (-27.1), texture: { png, uv: uvLookup(grid), name: 'my terrain.png' }, name: 'Vegas' });
    const z = unzipSync(kmz);
    expect(Object.keys(z).sort()).toEqual(['doc.kml', 'models/model.dae', 'models/my_terrain.png']);
    const km = kmlModel(strFromU8(z['doc.kml']));
    expect(km).toMatchObject({ href: 'models/model.dae', altitudeMode: 'absolute' });
    expect(km.lat).toBeCloseTo(grid.origin.lat, 8);
    expect(km.altitude).toBeCloseTo(627.1, 3);
    const doc = readCollada(strFromU8(z['models/model.dae']));
    expect(doc.models[0].image).toBe('my_terrain.png');
  });
});
