// 3D bridge (2.0 plan P7; REQ-HUB-03): the view's ground as a textured terrain mesh for Blender,
// Unreal and iOS. A regular grid over the view's ground footprint takes its heights from the
// loaded DEMs; the texture is a chip of the view as shown (enhancements and graphics included),
// mapped through the image's sensor model. GLB comes from the app's own glTF writer; USDZ (iOS
// Quick Look, textures ≤ 4096 px) from three.js's USDZExporter in the lazy three block.
// Coordinates are local east-north-up metres about the grid centre (a tangent plane, < 0.1 %
// scale error over 10 km).

/** Local ENU (metres) of (lat, lon, h) about origin {lat, lon, h}. */
export function enu(o, lat, lon, h) {
  const k = Math.PI / 180;
  return [(lon - o.lon) * k * 6378137 * Math.cos(o.lat * k), (lat - o.lat) * k * 6378137, h - o.h];
}

/**
 * The terrain model: {vertices [[x, y, z]], faces [{idx}], uv Map(key → [u, v]), origin, n, metres}.
 * ground(i, j) → {lat, lon, h, u, v} for grid node (i, j) of n × n (u, v: texture position).
 */
export function terrainGrid(n, ground) {
  const nodes = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) nodes.push(ground(i, j));
  if (nodes.some((g) => !g)) throw new Error('part of the view has no ground position (sky, or outside the sensor model)');
  const c = nodes[Math.floor(n / 2) * n + Math.floor(n / 2)];
  const origin = { lat: c.lat, lon: c.lon, h: Math.min(...nodes.map((g) => g.h)) };
  const vertices = nodes.map((g) => enu(origin, g.lat, g.lon, g.h));
  const uv = new Map();
  nodes.forEach((g, k) => uv.set(vertices[k].map((v) => v.toFixed(4)).join(','), [g.u ?? 0, g.v ?? 0]));
  const faces = [];
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      faces.push({ idx: [a, a + 1, a + n + 1] }, { idx: [a, a + n + 1, a + n] });
    }
  // Faces wind counter-clockwise seen from above (normals up), whatever the view's orientation.
  const [p, q, r] = faces[0].idx.map((k) => vertices[k]);
  if ((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]) < 0) for (const f of faces) f.idx.reverse();
  const xs = vertices.map((v) => v[0]);
  const ys = vertices.map((v) => v[1]);
  return { vertices, faces, uv, origin, n, metres: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] };
}

/** uv lookup for writeGltf's texture option. */
export const uvLookup = (grid) => (x, y, z) => grid.uv.get([x, y, z].map((v) => v.toFixed(4)).join(',')) ?? [0, 0];
