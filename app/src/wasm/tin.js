// `tin` bundle wrapper (REQ-GAP-39): main thread (edits, display queries, raster) and analysis
// worker (builds). A TIN is a handle into the instance; the worker hands a built TIN over as its
// state bytes (save → load). DOM-free.

import { Bundle } from './abi.js';

/** Line kinds (gw_tin::mesh). */
export const KIND = { hard: 1, soft: 2, void: 3, outer: 4, swap: 5, drain: 6, ridge: 7, outline: 8 };
export const KIND_NAME = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));

const f64 = (o) => new Float64Array(o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength));

export class TinBundle extends Bundle {
  constructor(module) {
    super(module, 'tin');
  }

  /** A handle from a call returning one (≥ 1) or minus a status code. */
  _id(r, fn) {
    if (r <= 0) this.check(-r || 5, fn);
    return r;
  }

  /** TIN through points (x, y, z triples, plane metres) → {id, report}. */
  fromPoints(pts, { q = 0.001, cell = 0, maxPoints = 3e6 } = {}) {
    return this.guard(() => {
      const [a, an] = this.putF64([q, cell, maxPoints]);
      const [b, bn] = this.putF64(pts);
      try {
        const id = this._id(this.x.gw_tin_from_points(a, 3, b, pts.length), 'fromPoints');
        return { id, report: this.outJson() };
      } finally {
        this.free(a, an);
        this.free(b, bn);
      }
    });
  }

  /** TIN from DEM posts: grid {w, h, ax, ay, bx, by} (post (i, j) at ax + bx·i, ay + by·j), heights f32; tolerance < 0 takes every post. */
  fromDem(grid, z, { tolerance = 0.5, maxPoints = 3e6, q = 0.001 } = {}) {
    return this.guard(() => {
      const [a, an] = this.putF64([grid.w, grid.h, grid.ax, grid.ay, grid.bx, grid.by, tolerance, maxPoints, q]);
      const [b, bn] = this.putF32(z);
      try {
        const id = this._id(this.x.gw_tin_from_dem(a, 9, b, z.length), 'fromDem');
        return { id, report: this.outJson() };
      } finally {
        this.free(a, an);
        this.free(b, bn);
      }
    });
  }

  dispose(id) {
    this.x.gw_tin_free(id);
  }

  /** The TIN's state bytes. */
  save(id) {
    return this.guard(() => {
      this.check(this.x.gw_tin_save(id), 'save');
      return this.outBytes();
    });
  }

  /** A TIN from state bytes → handle. */
  load(bytes) {
    return this.guard(() => {
      const [p, n] = this.put(bytes);
      try {
        return this._id(this.x.gw_tin_load(p, n), 'load');
      } finally {
        this.free(p, n);
      }
    });
  }

  /** Apply a flat edit list (gw_tin::ops) → one result per edit {ok, broken, msg, added, removed, changed, profile}. */
  apply(id, ops) {
    return this.guard(() => {
      const [p, n] = this.putF64(ops);
      try {
        this.check(this.x.gw_tin_apply(id, p, ops.length), 'apply');
        return this.outJson();
      } finally {
        this.free(p, n);
      }
    });
  }

  /**
   * Keep a file's own faces in a TIN built through its points (LandXML): `pts` = the file's x, y, z
   * (plane metres), `faces` = Uint32Array of point indices, three per face, `hidden` = one byte per
   * face → {faces, skipped, forced, rings, kept}.
   */
  keepFaces(id, pts, faces, hidden = new Uint8Array(0)) {
    return this.guard(() => {
      const [a, an] = this.putF64(pts);
      const [b, bn] = this.put(new Uint8Array(faces.buffer, faces.byteOffset, faces.byteLength));
      const [c, cn] = this.put(hidden);
      try {
        this.check(this.x.gw_tin_keep_faces(id, a, pts.length, b, faces.byteLength, c, hidden.length), 'keepFaces');
        return this.outJson();
      } finally {
        this.free(a, an);
        this.free(b, bn);
        this.free(c, cn);
      }
    });
  }

  info(id) {
    return this.guard(() => {
      this.check(this.x.gw_tin_info(id), 'info');
      return this.outJson();
    });
  }

  /** Lines: [{key, kind, closed, defs: Float64Array xyz, path: Float64Array xyz}]. */
  lines(id) {
    return this.guard(() => {
      this.check(this.x.gw_tin_lines(id), 'lines');
      const v = f64(this.outBytes());
      const out = [];
      for (let k = 0; k + 5 <= v.length; ) {
        const [key, kind, closed, nd, np] = v.subarray(k, k + 5);
        k += 5;
        const defs = v.slice(k, k + 3 * nd);
        k += 3 * nd;
        const path = v.slice(k, k + 3 * np);
        k += 3 * np;
        out.push({ key, kind, closed: closed !== 0, defs, path });
      }
      return out;
    });
  }

  /**
   * Triangles meeting a plane box [x0, y0, x1, y1] (all with no box), at most `cap`:
   * {xyz: Float64Array, tris: Uint32Array, edges: Uint32Array, excluded: Uint8Array, kinds: Uint8Array, total}.
   */
  mesh(id, box = null, cap = -1) {
    return this.guard(() => {
      const b = box ?? [-Infinity, -Infinity, Infinity, Infinity];
      const [p, n] = this.putF64([b[0], b[1], b[2], b[3], cap]);
      try {
        this.check(this.x.gw_tin_mesh(id, p, 5), 'mesh');
        const o = this.outBytes();
        const dv = new DataView(o.buffer, o.byteOffset, o.byteLength);
        const [nv, nt, ne, total] = [0, 4, 8, 12].map((k) => dv.getUint32(k, true));
        let at = 16;
        const xyz = new Float64Array(o.buffer.slice(o.byteOffset + at, o.byteOffset + at + 24 * nv));
        at += 24 * nv;
        const tris = new Uint32Array(o.buffer.slice(o.byteOffset + at, o.byteOffset + at + 12 * nt));
        at += 12 * nt;
        const edges = new Uint32Array(o.buffer.slice(o.byteOffset + at, o.byteOffset + at + 8 * ne));
        at += 8 * ne;
        const excluded = o.slice(at, at + nt);
        at += nt;
        const kinds = o.slice(at, at + ne);
        return { xyz, tris, edges, excluded, kinds, total };
      } finally {
        this.free(p, n);
      }
    });
  }

  /** Heights at plane points (x, y pairs) → Float64Array (NaN outside or excluded). */
  heights(id, xy) {
    return this.guard(() => {
      const [p, n] = this.putF64(xy);
      try {
        this.check(this.x.gw_tin_heights(id, p, xy.length), 'heights');
        return f64(this.outBytes());
      } finally {
        this.free(p, n);
      }
    });
  }

  /** TIN → grid {w, h, ax, ay, bx, by} → Float32Array (NaN outside the TIN). */
  raster(id, g) {
    return this.guard(() => {
      const [p, n] = this.putF64([g.w, g.h, g.ax, g.ay, g.bx, g.by]);
      try {
        this.check(this.x.gw_tin_raster(id, p, 6), 'raster');
        const o = this.outBytes();
        return new Float32Array(o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength));
      } finally {
        this.free(p, n);
      }
    });
  }

  /** Snap target within r m: {vertex: {x, y, z, mass, line} | null, line: {key, x, y, z} | null}. */
  snap(id, x, y, r) {
    return this.guard(() => {
      this.check(this.x.gw_tin_snap(id, x, y, r), 'snap');
      const v = f64(this.outBytes());
      return {
        vertex: v[0] ? { x: v[1], y: v[2], z: v[3], mass: !!v[4], line: !!v[5] } : null,
        line: v[6] ? { key: v[7], x: v[8], y: v[9], z: v[10] } : null,
      };
    });
  }

  /**
   * LandXML text bytes → {doc (summary, lines, refused, warnings), points, extra, lines: [{kind, name, closed, pts}], faces, hidden}.
   * Coordinates: x easting, y northing, z, in metres.
   */
  landxml(bytes, surface = 0) {
    return this.guard(() => {
      const [p, n] = this.put(bytes);
      try {
        this.check(this.x.gw_landxml_read(p, n, surface), 'landxml');
        const o = this.outBytes();
        const dv = new DataView(o.buffer, o.byteOffset, o.byteLength);
        const jl = dv.getUint32(0, true);
        const doc = JSON.parse(new TextDecoder().decode(o.subarray(4, 4 + jl)));
        let at = (4 + jl + 7) & ~7;
        const take = (k) => {
          const a = new Float64Array(o.buffer.slice(o.byteOffset + at, o.byteOffset + at + 8 * k));
          at += 8 * k;
          return a;
        };
        const points = take(3 * doc.points);
        const extra = take(3 * doc.extra);
        const lines = doc.lines.map((l) => ({ ...l, pts: take(3 * l.n) }));
        const faces = new Uint32Array(o.buffer.slice(o.byteOffset + at, o.byteOffset + at + 12 * doc.faces));
        at += 12 * doc.faces;
        const hidden = o.slice(at, at + doc.faces);
        return { doc, points, extra, lines, faces, hidden };
      } finally {
        this.free(p, n);
      }
    });
  }

  /** Delimited text bytes → {header, delimiter, rows, cols, values: Float64Array rows × cols, text: Map(col → strings)}. */
  pointsText(bytes) {
    return this.guard(() => {
      const [p, n] = this.put(bytes);
      try {
        this.check(this.x.gw_points_read(p, n), 'pointsText');
        const o = this.outBytes();
        const jl = new DataView(o.buffer, o.byteOffset, o.byteLength).getUint32(0, true);
        const j = JSON.parse(new TextDecoder().decode(o.subarray(4, 4 + jl)));
        const at = (4 + jl + 7) & ~7;
        const values = new Float64Array(o.buffer.slice(o.byteOffset + at, o.byteOffset + at + 8 * j.rows * j.cols));
        return { ...j, values, text: new Map(j.text) };
      } finally {
        this.free(p, n);
      }
    });
  }
}

// ---- the edit list (gw_tin::ops) ----
/** Edit records {kind, params} → the flat f64 list. Coordinates are TIN-plane metres. */
export function encodeTinEdits(edits) {
  const a = [edits.length];
  const pts3 = (pts) => {
    a.push(pts.length);
    for (const p of pts) a.push(p[0], p[1], p[2] ?? NaN);
  };
  const pts2 = (pts) => {
    a.push(pts.length);
    for (const p of pts) a.push(p[0], p[1]);
  };
  for (const e of edits) {
    const p = e.params ?? {};
    switch (e.kind) {
      case 'addpoint':
        a.push(1, p.x, p.y, p.z);
        break;
      case 'delpoint':
        a.push(2, p.x, p.y, p.r ?? 0.001);
        break;
      case 'movepoint':
        a.push(3, p.x, p.y, p.r ?? 0.001, p.nx, p.ny, p.nz ?? NaN);
        break;
      case 'addline':
      case 'setline':
        a.push(e.kind === 'addline' ? 4 : 6, p.key, KIND[p.type] ?? 1, p.closed ? 1 : 0);
        pts3(p.pts);
        break;
      case 'delline':
        a.push(5, p.key);
        break;
      case 'profile':
        a.push(7, p.key, p.mode === 'ridge' ? 2 : 1);
        pts2(p.pts);
        break;
      case 'delin':
        a.push(8);
        pts2(p.ring);
        break;
      case 'swap':
        a.push(9, p.key, p.x, p.y);
        break;
      case 'retri':
        a.push(10);
        pts2(p.ring);
        break;
      default:
        throw Object.assign(new Error(`unknown TIN edit "${e.kind}"`), { code: 'E_TIN_EDIT_KIND' });
    }
  }
  return a;
}
