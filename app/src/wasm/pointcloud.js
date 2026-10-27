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
