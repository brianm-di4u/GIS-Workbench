// `pointcloud` bundle wrapper (point-cloud workers): LAS/LAZ headers, record and LAZ-chunk
// decoding, the LOD index, gridding, SMRF, profiles and LAS 1.4 export (REQ-LDR-01..10).

import { Bundle } from './abi.js';

const enc = new TextEncoder();

/** Byte layout of decoded columns (gw-pointcloud `Columns::to_bytes`): views over `buf`. */
export function columnsOf(buf, n, rgb) {
  let o = 0;
  const take = (Ctor, count, bytes) => {
    const v = new Ctor(buf, o, count);
    o += Math.ceil((count * bytes) / 4) * 4;
    return v;
  };
  return {
    n,
    pos: take(Float32Array, 3 * n, 4),
    time: take(Float32Array, n, 4),
    intensity: take(Uint16Array, n, 2),
    source: take(Uint16Array, n, 2),
    scan: take(Int16Array, n, 2),
    rgb: rgb ? take(Uint16Array, 3 * n, 2) : null,
    class: take(Uint8Array, n, 1),
    ret: take(Uint8Array, n, 1),
    flags: take(Uint8Array, n, 1),
    user: take(Uint8Array, n, 1),
  };
}

/** The same layout packed from separate arrays (for export). */
export function packColumns(c) {
  const n = c.n;
  const pad = (b) => Math.ceil(b / 4) * 4;
  const sizes = [12 * n, 4 * n, pad(2 * n), pad(2 * n), pad(2 * n), c.rgb ? pad(6 * n) : 0, pad(n), pad(n), pad(n), pad(n)];
  const out = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  let o = 0;
  const put = (arr, size) => {
    if (arr) out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), o);
    o += size;
  };
  [c.pos, c.time, c.intensity, c.source, c.scan, c.rgb, c.class, c.ret, c.flags, c.user].forEach((a, i) => put(a, sizes[i]));
  return out;
}

/** Points [a, b) of packed columns (the packColumns layout) as packed columns of their own. */
export function sliceColumns(packed, n, rgb, a, b) {
  const m = b - a;
  const pad = (x) => Math.ceil(x / 4) * 4;
  const per = [12, 4, 2, 2, 2, rgb ? 6 : 0, 1, 1, 1, 1];
  const sizeOf = (bp, k) => (bp === 12 || bp === 4 ? bp * k : pad(bp * k));
  const out = new Uint8Array(per.reduce((t, bp) => t + sizeOf(bp, m), 0));
  let src = 0;
  let dst = 0;
  for (const bp of per) {
    out.set(packed.subarray(src + a * bp, src + b * bp), dst);
    src += sizeOf(bp, n);
    dst += sizeOf(bp, m);
  }
  return out;
}

export class PointCloudBundle extends Bundle {
  constructor(module) {
    super(module, 'pointcloud');
  }

  _bytes(u8, call) {
    const [p, n] = this.put(u8);
    try {
      return call(p, n);
    } finally {
      this.free(p, n);
    }
  }

  /** Optional typed input: [ptr, len] or [0, 0]. */
  _opt(arr, putter, call) {
    if (!arr || !arr.length) return call(0, 0);
    const [p, n] = putter.call(this, arr);
    try {
      return call(p, arr.length);
    } finally {
      this.free(p, n);
    }
  }

  info(head) {
    return this.guard(() => this._bytes(head, (p, n) => (this.check(this.x.gw_las_info(p, n), 'las info'), this.outJson())));
  }

  evlrs(buf, start, count) {
    return this.guard(() => this._bytes(buf, (p, n) => (this.check(this.x.gw_las_evlrs(p, n, start, count), 'evlrs'), this.outJson())));
  }

  wkt(text) {
    return this.guard(() => this.withStr(text, (p, n) => (this.check(this.x.gw_wkt_info(p, n), 'wkt'), this.outJson())));
  }

  lazChunks(vlr, table, nPoints) {
    return this.guard(() =>
      this._bytes(vlr, (vp, vn) =>
        this._bytes(table, (tp, tn) => {
          this.check(this.x.gw_laz_chunks(vp, vn, tp, tn, nPoints), 'laz chunk table');
          return new Float64Array(this.outBytes().buffer);
        }),
      ),
    );
  }

  decodeLas(prm, raw) {
    return this.guard(() => {
      const [a, an] = this.putF64(prm);
      try {
        return this._bytes(raw, (p, n) => (this.check(this.x.gw_las_decode(a, prm.length, p, n), 'las decode'), this.outBytes()));
      } finally {
        this.free(a, an);
      }
    });
  }

  /** A streamed LAZ without a chunk table, decoded sequentially (TE-022). */
  decodeLazStream(prm, vlr, data, n) {
    return this.guard(() => {
      const [a, an] = this.putF64(prm);
      try {
        return this._bytes(vlr, (vp, vn) => this._bytes(data, (dp, dn) => (this.check(this.x.gw_laz_decode_stream(a, prm.length, vp, vn, dp, dn, n), 'laz stream decode'), this.outBytes())));
      } finally {
        this.free(a, an);
      }
    });
  }

  decodeLaz(prm, vlr, data, chunks) {
    return this.guard(() => {
      const [a, an] = this.putF64(prm);
      const [c, cn] = this.putF64(chunks);
      try {
        return this._bytes(vlr, (vp, vn) => this._bytes(data, (dp, dn) => (this.check(this.x.gw_laz_decode(a, prm.length, vp, vn, dp, dn, c, chunks.length), 'laz decode'), this.outBytes())));
      } finally {
        this.free(a, an);
        this.free(c, cn);
      }
    });
  }

  index(pos, tile, s0, maxLevel) {
    return this.guard(() => {
      const [p, pn] = this.putF32(pos);
      try {
        this.check(this.x.gw_pc_index(p, pos.length, tile, s0, maxLevel), 'lod index');
        const b = this.outBytes();
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const nt = dv.getUint32(0, true);
        const n = dv.getUint32(4, true);
        // The permutation is read straight from the module's memory (TE-021), then released.
        const perm = new Uint32Array(n);
        perm.set(new Uint32Array(this.x.memory.buffer, this.x.gw_pc_index_perm(), n));
        this.x.gw_pc_index_release();
        const f = new Float64Array(b.buffer, b.byteOffset + 8, (b.byteLength - 8) / 8);
        const tiles = [];
        let k = 0;
        for (let t = 0; t < nt; t++) {
          const nl = f[k + 8];
          tiles.push({ start: f[k], count: f[k + 1], min: [f[k + 2], f[k + 3], f[k + 4]], max: [f[k + 5], f[k + 6], f[k + 7]], levels: Array.from(f.subarray(k + 9, k + 9 + nl)) });
          k += 9 + nl;
        }
        return { perm, tiles };
      } finally {
        this.free(p, pn);
      }
    });
  }

  grid(pos, mask, val, prm) {
    return this.guard(() => {
      const [p, pn] = this.putF32(pos);
      const [a, an] = this.putF64(prm);
      try {
        return this._opt(mask, this.put, (mp, ml) =>
          this._opt(val, this.putF32, (vp, vl) => {
            this.check(this.x.gw_pc_grid(p, pos.length, mp, ml, vp, vl, a, prm.length), 'grid');
            return new Float32Array(this.outBytes().buffer);
          }),
        );
      } finally {
        this.free(p, pn);
        this.free(a, an);
      }
    });
  }

  smrf(pos, mask, prm) {
    return this.guard(() => {
      const [p, pn] = this.putF32(pos);
      const [a, an] = this.putF64(prm);
      try {
        return this._opt(mask, this.put, (mp, ml) => (this.check(this.x.gw_pc_smrf(p, pos.length, mp, ml, a, prm.length), 'smrf'), this.outBytes()));
      } finally {
        this.free(p, pn);
        this.free(a, an);
      }
    });
  }

  profile(pos, mask, prm) {
    return this.guard(() => {
      const [p, pn] = this.putF32(pos);
      const [a, an] = this.putF64(prm);
      try {
        return this._opt(mask, this.put, (mp, ml) => {
          this.check(this.x.gw_pc_profile(p, pos.length, mp, ml, a, prm.length), 'profile');
          const b = this.outBytes();
          const c = new DataView(b.buffer).getUint32(0, true);
          return { index: new Uint32Array(b.buffer, 4, c), along: new Float32Array(b.buffer, 4 + 4 * c, c), across: new Float32Array(b.buffer, 4 + 8 * c, c) };
        });
      } finally {
        this.free(p, pn);
        this.free(a, an);
      }
    });
  }

  /** Slab export, pass 1: f64 [min x, y, z, max x, y, z] of a slab's target coordinates. */
  lasBounds(cols, n, rgb, inv) {
    return this.guard(() => {
      const [i, inN] = this.putF64(inv);
      try {
        return this._bytes(cols, (cp, cn) => (this.check(this.x.gw_las_bounds(cp, cn, n, rgb ? 1 : 0, i, inv.length), 'las bounds'), new Float64Array(this.outBytes().buffer)));
      } finally {
        this.free(i, inN);
      }
    });
  }

  /** Slab export, pass 2: {entries: [(points, bytes)…], byReturn, body} for a slab (prm: write parameters + offset). */
  lasSlab(cols, n, rgb, inv, prm) {
    return this.guard(() => {
      const [i, inN] = this.putF64(inv);
      const [a, an] = this.putF64(prm);
      try {
        const out = this._bytes(cols, (cp, cn) => (this.check(this.x.gw_las_slab(cp, cn, n, rgb ? 1 : 0, i, inv.length, a, prm.length), 'las slab'), this.outBytes()));
        const dv = new DataView(out.buffer);
        const k = dv.getUint32(0, true);
        const entries = [];
        for (let j = 0; j < k; j++) entries.push([Number(dv.getBigUint64(4 + 16 * j, true)), Number(dv.getBigUint64(12 + 16 * j, true))]);
        const o = 4 + 16 * k;
        const byReturn = Array.from({ length: 15 }, (_, j) => Number(dv.getBigUint64(o + 8 * j, true)));
        return { entries, byReturn, body: out.subarray(o + 120) };
      } finally {
        this.free(i, inN);
        this.free(a, an);
      }
    });
  }

  /** Slab export, last: {head, table} (prm: write parameters, offset, min, max, points, body bytes, by return). */
  lasHead(prm, entries, text) {
    return this.guard(() => {
      const [a, an] = this.putF64(prm);
      const flat = entries.flat();
      const [e, en] = this.putF64(flat.length ? flat : [0]);
      try {
        const out = this._bytes(enc.encode(text), (tp, tn) => (this.check(this.x.gw_las_head(a, prm.length, e, flat.length, tp, tn), 'las head'), this.outBytes()));
        const h = new DataView(out.buffer).getUint32(0, true);
        return { head: out.subarray(4, 4 + h), table: out.subarray(4 + h) };
      } finally {
        this.free(a, an);
        this.free(e, en);
      }
    });
  }

  write(cols, n, rgb, inv, prm, text) {
    return this.guard(() => {
      const [i, inN] = this.putF64(inv);
      const [a, an] = this.putF64(prm);
      try {
        return this._bytes(cols, (cp, cn) => this._bytes(enc.encode(text), (tp, tn) => (this.check(this.x.gw_las_write(cp, cn, n, rgb ? 1 : 0, i, inv.length, a, prm.length, tp, tn), 'las write'), this.outBytes())));
      } finally {
        this.free(i, inN);
        this.free(a, an);
      }
    });
  }
}
