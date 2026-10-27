// Quantized-mesh terrain (REQ-ARC-16): Cesium quantized-mesh-1.0 tiles from an online source
// (layer.json + {z}/{x}/{y}.terrain, TMS, geographic EPSG:4326 tiling with two tiles at level 0).
// A tile is a header (centre, height range, bounding sphere, horizon point), zig-zag delta
// encoded u/v/height vertex arrays (0…32767 over the tile), high-water-mark encoded triangle
// indices and edge lists; extensions are ignored. Vertices go to the 3D view's local frame.

const zz = (v) => (v >> 1) ^ -(v & 1);

/** One tile's bytes → {vertices: [{lat, lon, h}], indices: Uint32Array, min, max}. */
export function decodeQuantizedMesh(bytes, { west, south, east, north }) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 88 + 4) throw new Error('quantized-mesh tile too short');
  const minH = dv.getFloat32(24, true);
  const maxH = dv.getFloat32(28, true);
  let p = 88;
  const n = dv.getUint32(p, true);
  p += 4;
  if (n === 0 || p + n * 6 > bytes.length) throw new Error('quantized-mesh vertex data runs past the tile');
  const u = new Uint16Array(n);
  const v = new Uint16Array(n);
  const hh = new Uint16Array(n);
  let a = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    a += zz(dv.getUint16(p + 2 * i, true));
    b += zz(dv.getUint16(p + 2 * n + 2 * i, true));
    c += zz(dv.getUint16(p + 4 * n + 2 * i, true));
    u[i] = a;
    v[i] = b;
    hh[i] = c;
  }
  p += 6 * n;
  const wide = n > 65536;
  if (wide && p % 4) p += 4 - (p % 4);
  else if (!wide && p % 2) p += 1;
  const tri = dv.getUint32(p, true);
  p += 4;
  const size = wide ? 4 : 2;
  if (p + tri * 3 * size > bytes.length) throw new Error('quantized-mesh index data runs past the tile');
  const idx = new Uint32Array(tri * 3);
  let highest = 0;
  for (let i = 0; i < tri * 3; i++) {
    const code = wide ? dv.getUint32(p + 4 * i, true) : dv.getUint16(p + 2 * i, true);
    idx[i] = highest - code;
    if (code === 0) highest++;
  }
  const vertices = [];
  for (let i = 0; i < n; i++) vertices.push({ lon: west + (u[i] / 32767) * (east - west), lat: south + (v[i] / 32767) * (north - south), h: minH + (hh[i] / 32767) * (maxH - minH) });
  return { vertices, indices: idx, min: minH, max: maxH };
}

/** Geographic TMS tile bounds (degrees) at level z: 2^(z+1) × 2^z tiles. */
export function tileBounds(z, x, y) {
  const s = 180 / 2 ** z;
  return { west: -180 + x * s, east: -180 + (x + 1) * s, south: -90 + y * s, north: -90 + (y + 1) * s };
}

/** Tiles at level z covering a box [south, west, north, east]. */
export function tilesFor(z, [s, w, n, e]) {
  const sz = 180 / 2 ** z;
  const out = [];
  for (let x = Math.floor((w + 180) / sz); x <= Math.floor((e + 180) / sz - 1e-12); x++) for (let y = Math.floor((s + 90) / sz); y <= Math.floor((n + 90) / sz - 1e-12); y++) out.push([z, x, y]);
  return out;
}

/** Load the tiles of a layer.json over a box at a level into the 3D view as terrain meshes. */
export async function loadQuantizedMesh(view, layerUrl, fetch, { box, level = 12, maxTiles = 64 } = {}) {
  const r = await fetch(layerUrl, { credentials: 'omit' });
  if (!r.ok) throw new Error(`${layerUrl}: HTTP ${r.status}`);
  const layer = await r.json();
  if (!/quantized-mesh/i.test(layer.format ?? '') && !layer.tiles) throw new Error('not a quantized-mesh layer.json');
  if (layer.projection && layer.projection !== 'EPSG:4326') throw new Error(`terrain projection ${layer.projection} is not read (EPSG:4326 only)`);
  const z = Math.min(level, layer.maxzoom ?? level);
  const tiles = tilesFor(z, box);
  if (tiles.length > maxTiles) throw new Error(`${tiles.length} tiles at level ${z}; choose a smaller box or a lower level`);
  const T = view.T;
  const group = new T.Group();
  const stats = { tiles: 0, vertices: 0, triangles: 0, failed: 0 };
  if (!view.origin) {
    const lat = (box[0] + box[2]) / 2;
    const s = Math.sin((lat * Math.PI) / 180);
    const w = 1 - 0.0066943799901413165 * s * s;
    view.setOrigin({ lat0: lat, lon0: (box[1] + box[3]) / 2, kx: ((6378137 / Math.sqrt(w)) * Math.cos((lat * Math.PI) / 180) * Math.PI) / 180, ky: (((6378137 * (1 - 0.0066943799901413165)) / (w * Math.sqrt(w))) * Math.PI) / 180 });
  }
  for (const [tz, tx, ty] of tiles) {
    const tmpl = layer.tiles[0].replace('{z}', tz).replace('{x}', tx).replace('{y}', ty).replace('{version}', layer.version ?? '1.0.0');
    const url = new URL(tmpl, layerUrl).href;
    try {
      const q = await fetch(url, { credentials: 'omit', headers: { Accept: 'application/vnd.quantized-mesh,application/octet-stream;q=0.9' } });
      if (!q.ok) throw new Error(`HTTP ${q.status}`);
      const t = decodeQuantizedMesh(new Uint8Array(await q.arrayBuffer()), tileBounds(tz, tx, ty));
      const pos = new Float32Array(t.vertices.length * 3);
      t.vertices.forEach((v, i) => {
        const [e, n] = view.toLocal(v.lat, v.lon);
        pos.set([e, n, v.h], 3 * i);
      });
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setIndex(new T.BufferAttribute(t.indices, 1));
      g.computeVertexNormals();
      const mesh = new T.Mesh(g, new T.MeshLambertMaterial({ color: 0x9a8f7a, side: T.DoubleSide }));
      mesh.userData = { tile: [tz, tx, ty], min: t.min, max: t.max };
      group.add(mesh);
      stats.tiles++;
      stats.vertices += t.vertices.length;
      stats.triangles += t.indices.length / 3;
    } catch (e) {
      stats.failed++;
      view.app.log('warn', `quantized-mesh ${tz}/${tx}/${ty}: ${e.message}`);
    }
  }
  view.world.add(group);
  const entry = { object: group, name: layer.name ?? 'quantized-mesh terrain', meshes: stats.tiles, placedBy: 'terrain', stats, layer };
  view.models.push(entry);
  view.invalidate();
  return entry;
}
