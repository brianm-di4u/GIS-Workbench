// `hydro` bundle wrapper (analysis worker, REQ-GAP-80, SDP-2.7 §4.2): hydrology on a whole grid
// (crates/gw-hydro). run() keeps the planes in WASM memory, one stage per call, and awaits
// `stage(name, fraction)` between stages so the worker reports progress and takes a cancel there.
// Memory follows S-63: the fill queue lives only inside the fill, heights are freed after the
// direction stages, and the watershed labels reuse the accumulation plane.

import { Bundle } from './abi.js';
import { gwError } from '../i18n/index.js';

/** The refusal threshold: TERRAIN_POSTS (layers/terrain.js), checked before anything is allocated. */
export const HYDRO_MAX_POSTS = 48e6;

/** Share of the run each stage starts at (S-63: the fill is about 85 % of the D8 chain). */
const AT = { fill: 0, d8: 0.7, dinf: 0.74, accumulate: 0.82, streams: 0.92, watershed: 0.95 };

export class HydroBundle extends Bundle {
  constructor(module) {
    super(module, 'hydro');
  }

  alloc(bytes) {
    const p = this.x.gw_alloc(bytes);
    if (!p) throw gwError('hydrology: out of memory allocating {n} bytes', { n: String(bytes) }, 'E_HYDRO_MEMORY');
    return [p, bytes];
  }

  u32Out() {
    const o = this.outBytes();
    return new Uint32Array(o.buffer, o.byteOffset, o.byteLength >> 2);
  }

  /**
   * Run the chain on heights `z` (Float32Array, NaN nodata) of `w` × `h` posts spaced `dx`, `dy` m.
   * opts: {eps (true), thresh (stream threshold in posts; 0 = no network), dinf (false), pour
   * (post indices), snap (posts, 0), want: names of the planes to return — filled, dir, acc,
   * strahler, shreve, labels, dinfAcc; the stream lines come back whenever thresh is set}.
   * Returns {stats, pour, streams, …wanted planes}.
   */
  async run(z, w, h, { dx, dy, eps = true, thresh = 0, dinf = false, pour = [], snap = 0, want = [] } = {}, stage = async () => {}) {
    const n = w * h;
    if (!(n > 0) || n !== z.length) throw new Error('hydrology: the heights do not match the grid size');
    if (n > HYDRO_MAX_POSTS) throw gwError('hydrology: {n} posts is more than the 48 million posts it takes; crop or resample the elevation model first', { n: String(n) }, 'E_HYDRO_SIZE');
    const wants = new Set(want);
    const out = { stats: { posts: n } };
    const held = [];
    const instance = this.traps; // a trap re-creates the instance: its pointers are then gone, not freed
    const take = (bytes) => {
      const a = this.alloc(bytes);
      held.push(a);
      return a[0];
    };
    const drop = (p) => {
      const k = held.findIndex((a) => a[0] === p);
      if (k >= 0) this.free(...held.splice(k, 1)[0]);
    };
    const copy = (T, p) => new T(this.mem, p, n).slice();
    try {
      await stage('fill', AT.fill);
      const zp = take(4 * n);
      new Float32Array(this.mem, zp, n).set(z);
      const dirp = take(n);
      this.guard(() => this.check(this.x.gw_hy_fill(zp, dirp, w, h, eps ? 1 : 0), 'hyFill'));
      const [valid, raised] = this.u32Out();
      Object.assign(out.stats, { valid, raised });
      if (wants.has('filled')) out.filled = copy(Float32Array, zp);

      await stage('d8', AT.d8);
      this.guard(() => this.check(this.x.gw_hy_d8(zp, dirp, w, h, dx, dy), 'hyD8'));
      out.stats.outlets = this.u32Out()[0];

      if (dinf) {
        await stage('dinf', AT.dinf);
        const angp = take(4 * n);
        this.guard(() => this.check(this.x.gw_hy_dinf(zp, dirp, angp, w, h, dx, dy), 'hyDinf'));
        drop(zp);
        const indeg = take(n);
        const daccp = take(4 * n);
        this.guard(() => this.check(this.x.gw_hy_dinf_accum(angp, indeg, daccp, w, h), 'hyDinfAccum'));
        const o = this.outBytes();
        out.stats.dinfLost = new DataView(o.buffer, o.byteOffset).getFloat64(8, true);
        if (wants.has('dinfAcc')) out.dinfAcc = copy(Float32Array, daccp);
        drop(daccp);
        drop(indeg);
        drop(angp);
      } else drop(zp);

      const network = thresh > 0;
      if (network || pour.length || ['acc', 'strahler', 'shreve', 'labels'].some((k) => wants.has(k))) {
        await stage('accumulate', AT.accumulate);
        const accp = take(4 * n);
        const sop = network || wants.has('strahler') ? take(n) : 0;
        const shp = network || wants.has('shreve') ? take(4 * n) : 0;
        this.guard(() => this.check(this.x.gw_hy_accum(dirp, accp, sop, shp, w, h, Math.max(1, thresh || 0xffffffff)), 'hyAccum'));
        out.stats.done = this.u32Out()[0];
        if (wants.has('acc')) out.acc = copy(Uint32Array, accp);
        if (wants.has('strahler') && sop) out.strahler = copy(Uint8Array, sop);
        if (wants.has('shreve') && shp) out.shreve = copy(Uint32Array, shp);
        if (network) {
          await stage('streams', AT.streams);
          this.guard(() => this.check(this.x.gw_hy_streams(dirp, accp, sop, shp, w, h, thresh), 'hyStreams'));
          out.streams = this.u32Out().slice();
        }
        if (sop) drop(sop);
        if (shp) drop(shp);
        if (pour.length) {
          await stage('watershed', AT.watershed);
          const pts = Uint32Array.from(pour);
          const pp = take(4 * pts.length);
          new Uint32Array(this.mem, pp, pts.length).set(pts);
          if (snap > 0) this.guard(() => this.check(this.x.gw_hy_snap(accp, pp, pts.length, w, h, snap), 'hySnap'));
          out.pour = Array.from(new Uint32Array(this.mem, pp, pts.length));
          out.pourAcc = out.pour.map((p) => new Uint32Array(this.mem, accp, n)[p]);
          // The labels take the accumulation plane's place.
          this.guard(() => this.check(this.x.gw_hy_label(dirp, pp, pts.length, accp, w, h), 'hyLabel'));
          if (wants.has('labels')) out.labels = copy(Uint32Array, accp);
          else out.areas = countLabels(new Uint32Array(this.mem, accp, n), pts.length);
        }
      }
      if (wants.has('dir')) out.dir = copy(Uint8Array, dirp);
      await stage('done', 1);
      return out;
    } finally {
      if (this.traps === instance) for (const a of held.splice(0)) this.free(...a);
    }
  }
}

/** Posts per label 1..k. */
export function countLabels(labels, k) {
  const c = new Array(k + 1).fill(0);
  for (let i = 0; i < labels.length; i++) if (labels[i]) c[labels[i]]++;
  return c.slice(1);
}

/** Decode stream links [count, strahler, shreve, post…] into [{strahler, shreve, posts}]. */
export function decodeStreams(v) {
  const links = [];
  for (let k = 0; k < v.length; ) {
    const c = v[k];
    links.push({ strahler: v[k + 1], shreve: v[k + 2], posts: v.subarray(k + 3, k + 3 + c) });
    k += 3 + c;
  }
  return links;
}
