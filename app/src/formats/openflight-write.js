// OpenFlight writer (REQ-GAP-35; OGC Community Standard 19-065, OpenFlight 16.0): buildings and
// terrain meshes as a .flt database, big-endian records:
//   Header (1, format revision 1600, metres, flat-earth projection, WGS 84, the origin and the
//   south-west / north-east corners as latitude and longitude) and a Comment (31) on the frame;
//   Color palette (32, white); Material palette (113, one material); Texture palette (64) naming
//   the texture image written beside the .flt (no external references are needed: one file
//   holds the whole database);
//   Vertex palette (67) of Vertex with Color, Normal and UV records (70);
//   Push / Group (2) / Push / per object: Object (4) with a Long ID (33) when its name is longer
//   than 7 characters, Push, one Face (5) per triangle with its Vertex list (72), Pop … Pop.
// Coordinates: x east and y north in metres from the origin (a tangent plane: the app's local
// frame), z metres above the WGS 84 ellipsoid (origin height added back). Texture coordinates are
// OpenFlight's (v up from the bottom of the image).

const te = new TextEncoder();

class Out {
  constructor() {
    this.chunks = [];
    this.size = 0;
  }
  rec(op, len, fill) {
    const L = len + ((4 - (len % 4)) % 4);
    if (L > 65535) throw new Error(`OpenFlight: record ${op} is ${L} bytes`);
    const b = new Uint8Array(L);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, op);
    dv.setUint16(2, L);
    fill?.(dv, b);
    this.chunks.push(b);
    this.size += L;
    return this.size - L;
  }
  bytes() {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

const ascii = (s) => te.encode(String(s).replace(/[^\x20-\x7e]/g, '_'));
function putId(b, at, id) {
  const s = ascii(id).subarray(0, 7);
  b.set(s, at);
}

/**
 * Write an OpenFlight database. `objects` = [{name, positions (Float64Array, local metres,
 * triangle soup), uv (Float32Array, top-left origin) | null, colour [r, g, b] 0..1}]; `origin` =
 * {lat, lon, h}; `toGeo(x, y, z)` → [lon, lat, h] for the corners; `texture` = file name of the
 * image beside the .flt (or null); `terrain` marks the faces as terrain.
 * → {bytes, vertices, faces, objects}.
 */
export function writeOpenFlight({ objects, origin, toGeo, texture = null, name = 'GIS Workbench', terrain = false, date = new Date() }) {
  if (!objects.length) throw new Error('nothing to write: no objects');
  const o = new Out();
  // Extent in latitude and longitude.
  let [lo0, la0, lo1, la1] = [Infinity, Infinity, -Infinity, -Infinity];
  let r2 = 0;
  for (const ob of objects)
    for (let i = 0; i < ob.positions.length; i += 3) {
      const [lon, lat] = toGeo(ob.positions[i], ob.positions[i + 1], ob.positions[i + 2]);
      lo0 = Math.min(lo0, lon);
      lo1 = Math.max(lo1, lon);
      la0 = Math.min(la0, lat);
      la1 = Math.max(la1, lat);
      r2 = Math.max(r2, ob.positions[i] ** 2 + ob.positions[i + 1] ** 2);
    }
  let nFaces = 0;
  for (const ob of objects) nFaces += ob.positions.length / 9;
  // Header (324 bytes).
  o.rec(1, 324, (dv, b) => {
    b.set(ascii('db'), 4);
    dv.setInt32(12, 1600);
    dv.setInt32(16, 1);
    b.set(ascii(date.toUTCString().slice(0, 31)), 20);
    dv.setInt16(52, Math.min(32767, 2));
    dv.setInt16(56, Math.min(32767, objects.length + 1));
    dv.setInt16(58, Math.min(32767, nFaces + 1));
    dv.setInt16(60, 1); // unit multiplier
    dv.setInt8(62, 0); // metres
    dv.setInt32(64, 0x80000000 | 0); // save vertex normals
    dv.setInt32(92, 0); // flat earth
    dv.setInt16(126, 1); // double-precision vertices
    dv.setInt32(128, 100); // OpenFlight
    dv.setFloat64(188, la0);
    dv.setFloat64(196, lo0);
    dv.setFloat64(204, la1);
    dv.setFloat64(212, lo1);
    dv.setFloat64(220, origin.lat);
    dv.setFloat64(228, origin.lon);
    dv.setInt32(268, 0); // WGS 84
    dv.setFloat64(292, Math.sqrt(r2));
  });
  const comment = te.encode(`${String(name).replace(/[\0]/g, '')}: written by GIS Workbench. x east and y north in metres from the origin latitude/longitude (flat earth), z in metres above the WGS 84 ellipsoid.\0`);
  o.rec(31, 4 + comment.length, (dv, b) => b.set(comment, 4));
  // Colour palette: 1024 white entries, no names.
  o.rec(32, 4228, (dv) => {
    for (let i = 0; i < 1024; i++) dv.setUint32(132 + 4 * i, 0xffffffff);
  });
  o.rec(113, 84, (dv, b) => {
    dv.setInt32(4, 0);
    b.set(ascii('material'), 8);
    dv.setInt32(20, 0x80000000 | 0);
    [0.4, 0.4, 0.4, 0.8, 0.8, 0.8, 0.1, 0.1, 0.1, 0, 0, 0].forEach((v, i) => dv.setFloat32(24 + 4 * i, v));
    dv.setFloat32(72, 8);
    dv.setFloat32(76, 1);
  });
  if (texture)
    o.rec(64, 216, (dv, b) => {
      b.set(ascii(texture).subarray(0, 199), 4);
      dv.setInt32(204, 0);
    });
  // Vertex palette: one Vertex with Color, Normal and UV record (64 bytes) per triangle corner.
  let nv = 0;
  for (const ob of objects) nv += ob.positions.length / 3;
  const palStart = o.size;
  o.rec(67, 8, (dv) => dv.setInt32(4, 8 + 64 * nv));
  const offsets = [];
  for (const ob of objects) {
    const P = ob.positions;
    const m = P.length / 3;
    const off = new Int32Array(m);
    const col = ob.colour ?? [1, 1, 1];
    const packed = ((255 << 24) | (Math.round(col[2] * 255) << 16) | (Math.round(col[1] * 255) << 8) | Math.round(col[0] * 255)) >>> 0;
    for (let t = 0; t < m; t += 3) {
      const ux = P[3 * t + 3] - P[3 * t];
      const uy = P[3 * t + 4] - P[3 * t + 1];
      const uz = P[3 * t + 5] - P[3 * t + 2];
      const wx = P[3 * t + 6] - P[3 * t];
      const wy = P[3 * t + 7] - P[3 * t + 1];
      const wz = P[3 * t + 8] - P[3 * t + 2];
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      for (let k = 0; k < 3; k++) {
        const v = t + k;
        off[v] =
          o.rec(70, 64, (dv) => {
            dv.setUint16(4, 0);
            dv.setInt16(6, 0x1000); // packed colour
            dv.setFloat64(8, P[3 * v]);
            dv.setFloat64(16, P[3 * v + 1]);
            dv.setFloat64(24, P[3 * v + 2] + origin.h);
            dv.setFloat32(32, nx);
            dv.setFloat32(36, ny);
            dv.setFloat32(40, nz);
            dv.setFloat32(44, ob.uv ? ob.uv[2 * v] : 0);
            dv.setFloat32(48, ob.uv ? 1 - ob.uv[2 * v + 1] : 0);
            dv.setUint32(52, packed);
            dv.setUint32(56, 0);
          }) - palStart;
      }
    }
    offsets.push(off);
  }
  // Hierarchy.
  const longId = (id) => {
    const s = ascii(id);
    if (s.length > 7) o.rec(33, 4 + s.length + 1, (dv, b) => b.set(s, 4));
  };
  o.rec(10, 4);
  o.rec(2, 44, (dv, b) => putId(b, 4, 'g1'));
  longId(name.length > 7 ? name : 'g1');
  o.rec(10, 4);
  let fi = 0;
  objects.forEach((ob, i) => {
    const id = ob.name ? String(ob.name) : `o${i + 1}`;
    o.rec(4, 28, (dv, b) => putId(b, 4, id));
    longId(id);
    o.rec(10, 4);
    const col = ob.colour ?? [1, 1, 1];
    const packed = ((255 << 24) | (Math.round(col[2] * 255) << 16) | (Math.round(col[1] * 255) << 8) | Math.round(col[0] * 255)) >>> 0;
    const off = offsets[i];
    for (let t = 0; t < off.length; t += 3) {
      fi++;
      o.rec(5, 80, (dv, b) => {
        putId(b, 4, `f${fi}`);
        dv.setInt8(18, terrain ? 1 : 0); // draw type: terrain without back-face culling
        dv.setInt8(19, 0);
        dv.setInt16(26, -1);
        dv.setInt16(28, texture && ob.uv ? 0 : -1);
        dv.setInt16(30, 0);
        dv.setInt32(44, ((terrain ? 0x80000000 : 0) | 0x10000000) | 0); // terrain, packed colour
        dv.setUint8(48, 2); // face colour and vertex normals
        dv.setUint32(56, packed);
        dv.setUint32(60, packed);
        dv.setInt16(64, -1);
        dv.setUint32(68, 0xffffffff);
        dv.setUint32(72, 0xffffffff);
        dv.setInt16(78, -1);
      });
      o.rec(10, 4);
      o.rec(72, 16, (dv) => {
        dv.setInt32(4, off[t]);
        dv.setInt32(8, off[t + 1]);
        dv.setInt32(12, off[t + 2]);
      });
      o.rec(11, 4);
    }
    o.rec(11, 4);
  });
  o.rec(11, 4);
  o.rec(11, 4);
  return { bytes: o.bytes(), vertices: nv, faces: fi, objects: objects.length };
}
