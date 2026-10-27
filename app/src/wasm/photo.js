// `photo` bundle wrapper (analysis worker): block adjustment (REQ-SNS-11), RPC fitting
// (REQ-SNS-15/16) and the tie-point matchers (REQ-SNS-13). Jobs are flat Float64Arrays built by
// features/triangulation.js; results come back as JSON.

import { Bundle } from './abi.js';

export class Photo extends Bundle {
  constructor(module) {
    super(module, 'photo');
  }

  adjust(job) {
    return this.guard(() => {
      const [p, n] = this.putF64(job);
      try {
        this.check(this.x.gw_adjust_block(p, job.length), 'adjust');
        return this.outJson();
      } finally {
        this.free(p, n);
      }
    });
  }

  fitRpc(job) {
    return this.guard(() => {
      const [p, n] = this.putF64(job);
      try {
        this.check(this.x.gw_fit_rpc(p, job.length), 'fitRpc');
        return this.outJson();
      } finally {
        this.free(p, n);
      }
    });
  }

  /** RPC00B fit to one KLV frame model (REQ-FMV-09): job of 18 values (see gw_fit_rpc_klv). */
  fitRpcKlv(job) {
    return this.guard(() => {
      const [p, n] = this.putF64(job);
      try {
        this.check(this.x.gw_fit_rpc_klv(p, job.length), 'fitRpcKlv');
        return this.outJson();
      } finally {
        this.free(p, n);
      }
    });
  }

  /** One DSM tile (REQ-DEM-04): prm Float64Array, source patches → {matched, pixels, sum, count, fomM, fomU}. */
  dsmTile(prm, left, right, n) {
    return this.guard(() => {
      const [a, an] = this.putF64(prm);
      const [l, ln] = this.putF32(left);
      const [r, rn] = this.putF32(right);
      try {
        this.check(this.x.gw_dsm_tile(a, prm.length, l, left.length, r, right.length), 'dsmTile');
        const b = this.outBytes();
        const f = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
        return { matched: f[0], pixels: f[1], sum: f.slice(2, 2 + n), count: f.slice(2 + n, 2 + 2 * n), fomM: Uint8Array.from(f.subarray(2 + 2 * n, 2 + 3 * n)), fomU: Uint8Array.from(f.subarray(2 + 3 * n, 2 + 4 * n)) };
      } finally {
        this.free(a, an);
        this.free(l, ln);
        this.free(r, rn);
      }
    });
  }

  /** ORB descriptor match of two Float32 windows (REQ-SNS-21) → {affine (b = A·(a, 1)) | null, pairs, …}. */
  orbMatch(a, aw, ah, b, bw, bh, n = 500, ratio = 0.85, tol = 2) {
    return this.guard(() => {
      const [pa, na] = this.putF32(a);
      const [pb, nb] = this.putF32(b);
      try {
        this.check(this.x.gw_orb_match(pa, aw, ah, pb, bw, bh, n, ratio, tol), 'orbMatch');
        return this.outJson();
      } finally {
        this.free(pa, na);
        this.free(pb, nb);
      }
    });
  }

  /** Harris corners of a Float32 window → [{x, y, score}]. */
  harris(px, w, h, n = 8, border = 12, minDist = 8) {
    return this.guard(() => {
      const [p, pn] = this.putF32(px);
      try {
        const { r, v } = this.outF64(3 * n, (o) => this.x.gw_harris(p, w, h, n, border, minDist, o));
        return Array.from({ length: r }, (_, k) => ({ x: v[3 * k], y: v[3 * k + 1], score: v[3 * k + 2] }));
      } finally {
        this.free(p, pn);
      }
    });
  }

  /** NCC (+ LSM) of a template into a search window → {x, y, ncc, ratio, sigma, lsmScore, ok}. */
  match(tpl, tw, th, srch, sw, sh, refine = true) {
    return this.guard(() => {
      const [a, an] = this.putF32(tpl);
      const [b, bn] = this.putF32(srch);
      try {
        const { v } = this.outF64(7, (o) => this.check(this.x.gw_match_point(a, tw, th, b, sw, sh, refine ? 1 : 0, o), 'match'));
        return { x: v[0], y: v[1], ncc: v[2], ratio: v[3], sigma: v[4], lsmScore: v[5], ok: v[6] };
      } finally {
        this.free(a, an);
        this.free(b, bn);
      }
    });
  }
}
