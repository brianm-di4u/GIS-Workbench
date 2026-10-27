// WebGPU DSM tiles (REQ-PRF-06): the worker's semi-global matcher (gw-match sgm.rs, dsm.rs) with
// the expensive part on the GPU — census, the Hamming cost volume over per-pixel ranges, the
// 8-path aggregation (one workgroup per scan line, threads across the disparities) and the
// winner-takes-all with its sub-pixel fit and uniqueness test. The rest follows the Rust code
// step by step in JS: rectification, the pyramid and its tSGM ranges, the left-right check, the
// 3 × 3 median, speckle removal, the figure of merit and the DSM accumulation through the
// intersection lookup. Same inputs and outputs as the `dsmTile` op. One difference by design:
// the right disparities for the left-right check come from the left volume (one aggregation,
// not two); `lrPass` runs the Rust code's right-referenced pass instead.

import { gpuDevice } from './gpu-viewshed.js';

const MAX_RANGE = 160;
const WG = 16; // threads per scan line in the aggregation (one hardware thread on most GPUs)
const INVALID = 64;
const FOM = { NODATA: 0, LR: 1, AMBIGUOUS: 2, SPECKLE: 3, MATCHED: 4 };
const T = { gpu: 0, post: 0, prep: 0, profile: false, stages: {} };
export const gpuSgmTiming = T;

const WGSL = /* wgsl */ `
struct P {
  w: u32, h: u32, rx: u32, ry: u32,
  p1: u32, p2: u32, uniq: f32, dminG: i32,
  dmaxG: i32, pad0: u32, pad1: u32, pad2: u32,
};
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> imgL: array<f32>;
@group(0) @binding(2) var<storage, read> imgR: array<f32>;
@group(0) @binding(3) var<storage, read_write> cenL: array<u32>;
@group(0) @binding(4) var<storage, read_write> cenR: array<u32>;
@group(0) @binding(5) var<storage, read> lo: array<i32>;
@group(0) @binding(6) var<storage, read> len: array<u32>;
@group(0) @binding(7) var<storage, read> off: array<u32>;
@group(0) @binding(8) var<storage, read_write> cost: array<u32>;
@group(0) @binding(9) var<storage, read_write> agg: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> res: array<u32>;

fn ok(v: f32) -> bool { return v > -1e29; }

fn censusAt(i: u32, isL: bool) -> vec3<u32> {
  let x = i32(i % p.w);
  let y = i32(i / p.w);
  let rx = i32(p.rx);
  let ry = i32(p.ry);
  if (x < rx || y < ry || x >= i32(p.w) - rx || y >= i32(p.h) - ry) { return vec3<u32>(0u, 0u, 0u); }
  var c: f32;
  if (isL) { c = imgL[i]; } else { c = imgR[i]; }
  if (!ok(c)) { return vec3<u32>(0u, 0u, 0u); }
  var hi = 0u; var lw = 0u; var valid = 1u;
  for (var dy = -ry; dy <= ry; dy++) {
    for (var dx = -rx; dx <= rx; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let k = u32((y + dy) * i32(p.w) + x + dx);
      var v: f32;
      if (isL) { v = imgL[k]; } else { v = imgR[k]; }
      if (!ok(v)) { valid = 0u; }
      hi = (hi << 1u) | (lw >> 31u);
      lw = (lw << 1u) | select(0u, 1u, v < c);
    }
  }
  return vec3<u32>(hi, lw, valid);
}

@compute @workgroup_size(64)
fn census(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= p.w * p.h) { return; }
  let a = censusAt(i, true);
  cenL[3u * i] = a.x; cenL[3u * i + 1u] = a.y; cenL[3u * i + 2u] = a.z;
  let b = censusAt(i, false);
  cenR[3u * i] = b.x; cenR[3u * i + 1u] = b.y; cenR[3u * i + 2u] = b.z;
}

// Costs and sums are 16-bit, two to a word: every pixel's range starts on an even entry, so
// entries k and k + 1 of a pixel share word (off + k) / 2. Sums of eight paths stay far below
// 65 535 (each path cost is at most the matching cost + 255).
fn half(word: u32, k: u32) -> u32 { return (word >> ((k & 1u) * 16u)) & 0xffffu; }

@compute @workgroup_size(64)
fn costs(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  let lane = id.y;
  if (i >= p.w * p.h) { return; }
  let o2 = off[i] / 2u;
  let l = len[i];
  let x = i32(i % p.w);
  let row = i - u32(x);
  let vl = cenL[3u * i + 2u] == 1u;
  for (var kp = lane; 2u * kp < l; kp += 8u) {
    var pair = 0u;
    for (var e = 0u; e < 2u; e++) {
      let k = 2u * kp + e;
      if (k >= l) { break; }
      var c = ${INVALID}u;
      let xr = x + lo[i] + i32(k);
      if (vl && xr >= 0 && xr < i32(p.w)) {
        let j = row + u32(xr);
        if (cenR[3u * j + 2u] == 1u) {
          c = countOneBits(cenL[3u * i] ^ cenR[3u * j]) + countOneBits(cenL[3u * i + 1u] ^ cenR[3u * j + 1u]);
        }
      }
      pair |= c << (16u * e);
    }
    cost[o2 + kp] = pair;
    atomicStore(&agg[o2 + kp], 0u);
  }
}

var<workgroup> buf: array<u32, ${2 * MAX_RANGE}>;
var<workgroup> wmin: array<atomic<u32>, 3>;

fn getPrev(pb: u32, kq: i32, ql: i32) -> u32 {
  if (kq >= 0 && kq < ql) { return buf[pb + u32(kq)]; }
  return 16383u;
}

const DX = array<i32, 8>(1, 0, 1, -1, -1, 0, -1, 1);
const DY = array<i32, 8>(0, 1, 1, 1, 0, -1, -1, -1);
const NP = ${MAX_RANGE / 2 / WG};

// All eight paths in one dispatch: workgroup (line, direction); each thread takes pairs of
// disparities. A line's path costs go through buf slice n % 2 (the previous pixel's in the
// other), the running minimum through wmin[n % 3] (reset two pixels ahead): one barrier per
// pixel. The next pixel's costs are fetched while this one is computed. Paths add into agg
// atomically, two disparities per add.
@compute @workgroup_size(${WG})
fn aggregate(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) t: u32) {
  let L = wid.x;
  let dir = wid.y;
  let dx = DX[dir];
  let dy = DY[dir];
  let w = i32(p.w);
  let h = i32(p.h);
  var nl = u32(w + h - 1);
  if (dy == 0) { nl = u32(h); } else if (dx == 0) { nl = u32(w); }
  if (L >= nl) { return; }
  var x: i32; var y: i32;
  if (dy == 0) { y = i32(L); x = select(w - 1, 0, dx > 0); }
  else if (dx == 0) { x = i32(L); y = select(h - 1, 0, dy > 0); }
  else {
    let li = i32(L);
    if (li < w) { x = li; y = select(h - 1, 0, dy > 0); }
    else {
      x = select(w - 1, 0, dx > 0);
      if (dy > 0) { y = li - w + 1; } else { y = h - 2 - (li - w); }
    }
  }
  if (t == 0u) { atomicStore(&wmin[0], 0xffffffffu); atomicStore(&wmin[1], 0xffffffffu); atomicStore(&wmin[2], 0xffffffffu); }
  workgroupBarrier();
  var it = 0u;
  var pmin = 0u;
  var plo = 0;
  var pl = 0;
  var pv = 0.0;
  var i = u32(y * w + x);
  var o2 = off[i] / 2u;
  var l = i32(len[i]);
  var me = imgL[i];
  var clo = lo[i];
  var cc: array<u32, NP>;
  for (var j = 0; j < NP; j++) {
    let kp = i32(t) + j * ${WG};
    if (2 * kp < l) { cc[j] = cost[o2 + u32(kp)]; }
  }
  loop {
    if (x < 0 || y < 0 || x >= w || y >= h) { break; }
    let nx = x + dx;
    let ny = y + dy;
    let more = nx >= 0 && ny >= 0 && nx < w && ny < h;
    let ni = select(i, u32(ny * w + nx), more);
    let no2 = off[ni] / 2u;
    let nlen = i32(len[ni]);
    let nme = imgL[ni];
    let nlo = lo[ni];
    var ncc: array<u32, NP>;
    for (var j = 0; j < NP; j++) {
      let kp = i32(t) + j * ${WG};
      if (more && 2 * kp < nlen) { ncc[j] = cost[no2 + u32(kp)]; }
    }
    let cb = (it % 2u) * ${MAX_RANGE}u;
    let pb = ((it + 1u) % 2u) * ${MAX_RANGE}u;
    if (t == 0u) { atomicStore(&wmin[(it + 1u) % 3u], 0xffffffffu); }
    var mn = 0xffffffffu;
    let g = abs(me - pv);
    let pp2 = max(u32(f32(p.p2) / (1.0 + g / 16.0)), p.p1 + 1u);
    let shift = clo - plo;
    for (var j = 0; j < NP; j++) {
      let kp = i32(t) + j * ${WG};
      if (2 * kp >= l) { break; }
      var add = 0u;
      for (var e = 0; e < 2; e++) {
        let k = 2 * kp + e;
        if (k >= l) { break; }
        var c = (cc[j] >> (16u * u32(e))) & 0xffffu;
        if (it > 0u) {
          let kq = k + shift;
          let m = min(min(getPrev(pb, kq, pl), getPrev(pb, kq - 1, pl) + p.p1), min(getPrev(pb, kq + 1, pl) + p.p1, pmin + pp2));
          c += min(m - min(m, pmin), 255u);
        }
        buf[cb + u32(k)] = c;
        add |= c << (16u * u32(e));
        mn = min(mn, c);
      }
      atomicAdd(&agg[o2 + u32(kp)], add);
    }
    atomicMin(&wmin[it % 3u], mn);
    workgroupBarrier();
    pmin = atomicLoad(&wmin[it % 3u]);
    plo = clo;
    pl = l;
    pv = me;
    it += 1u;
    x = nx;
    y = ny;
    i = ni;
    o2 = no2;
    l = nlen;
    me = nme;
    clo = nlo;
    cc = ncc;
  }
}

var<workgroup> wbest: array<atomic<u32>, 16>;
var<workgroup> wsecond: array<atomic<u32>, 16>;

fn sumAt(o2: u32, k: u32) -> u32 { return half(atomicLoad(&agg[o2 + k / 2u]), k); }

// Winner-takes-all, four lanes per pixel (16 pixels per workgroup): the lowest (sum, k) key
// gives the first minimum as the sequential scan does; then the second best outside ±1.
@compute @workgroup_size(64)
fn wta(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) t: u32) {
  let slot = t / 4u;
  let lane = t % 4u;
  let i = (wid.y * 256u + wid.x) * 16u + slot;
  let n = p.w * p.h;
  let live = i < n && cenL[3u * min(i, n - 1u) + 2u] == 1u;
  var o2 = 0u;
  var l = 0u;
  if (live) { o2 = off[i] / 2u; l = len[i]; }
  if (lane == 0u) { atomicStore(&wbest[slot], 0xffffffffu); atomicStore(&wsecond[slot], 65535u); }
  workgroupBarrier();
  var kb = 0xffffffffu;
  for (var k = lane; k < l; k += 4u) { kb = min(kb, (sumAt(o2, k) << 8u) | k); }
  atomicMin(&wbest[slot], kb);
  workgroupBarrier();
  let best = atomicLoad(&wbest[slot]) & 0xffu;
  var sm = 65535u;
  for (var k = lane; k < l; k += 4u) {
    if (abs(i32(k) - i32(best)) > 1) { sm = min(sm, sumAt(o2, k)); }
  }
  atomicMin(&wsecond[slot], sm);
  workgroupBarrier();
  if (lane != 0u || i >= n) { return; }
  res[3u * i + 2u] = 0u;
  if (!live || l == 0u) { return; }
  if (half(cost[o2 + best / 2u], best) == ${INVALID}u) { return; }
  let second = atomicLoad(&wsecond[slot]);
  let sb = max(f32(sumAt(o2, best)), 1.0);
  let margin = (f32(second) - sb) / sb;
  if (margin < p.uniq) { res[3u * i + 2u] = 1u; return; }
  var d = f32(lo[i] + i32(best));
  if (best > 0u && best + 1u < l) {
    let a = f32(sumAt(o2, best - 1u));
    let b = f32(sumAt(o2, best));
    let c = f32(sumAt(o2, best + 1u));
    let den = a - 2.0 * b + c;
    if (den > 0.0) { d += clamp(0.5 * (a - c) / den, -0.5, 0.5); }
  }
  res[3u * i] = bitcast<u32>(d);
  res[3u * i + 1u] = bitcast<u32>(margin);
  res[3u * i + 2u] = 2u;
}

// Right-image disparities from the left volume (Hirschmüller 2008 §3.4): right pixel xr takes
// the d whose left pixel xr − d has the lowest sum at d. Written over the right census words
// (no longer needed): word 0 holds the disparity as f32 bits, NaN when none.
@compute @workgroup_size(64)
fn wtaRight(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x + id.y * 65535u * 64u;
  if (i >= p.w * p.h) { return; }
  let xr = i32(i % p.w);
  let row = i - u32(xr);
  var best = 0xffffffffu;
  var bd = 0;
  if (cenR[3u * i + 2u] == 1u) {
    let x0 = max(0, xr - p.dmaxG);
    let x1 = min(i32(p.w) - 1, xr - p.dminG);
    for (var x = x0; x <= x1; x++) {
      let j = row + u32(x);
      if (cenL[3u * j + 2u] != 1u) { continue; }
      let k = xr - x - lo[j];
      if (k < 0 || u32(k) >= len[j]) { continue; }
      let sum = sumAt(off[j] / 2u, u32(k));
      if (sum < best) { best = sum; bd = xr - x; }
    }
  }
  cenR[3u * i] = select(0x7fc00000u, bitcast<u32>(f32(bd)), best != 0xffffffffu);
}
`;

const cache = new WeakMap();
const pools = new WeakMap();
function pipelines(device) {
  let c = cache.get(device);
  if (!c) {
    const B = (binding, type) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    const layout = device.createBindGroupLayout({ entries: [B(0, 'uniform'), B(1, 'read-only-storage'), B(2, 'read-only-storage'), B(3, 'storage'), B(4, 'storage'), B(5, 'read-only-storage'), B(6, 'read-only-storage'), B(7, 'read-only-storage'), B(8, 'storage'), B(9, 'storage'), B(10, 'storage')] });
    const module = device.createShaderModule({ code: WGSL });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const mk = (entryPoint) => device.createComputePipeline({ layout: pl, compute: { module, entryPoint } });
    c = { layout, census: mk('census'), costs: mk('costs'), aggregate: mk('aggregate'), wta: mk('wta'), wtaRight: mk('wtaRight') };
    cache.set(device, c);
  }
  return c;
}

/** One SGM pass on the GPU: per pixel status (0 none, 1 ambiguous, 2 matched), disparity, margin. */
async function gpuPass(device, left, right, w, h, lo, len, off, total, p) {
  if (device.limits.maxStorageBuffersPerShaderStage < 10) throw new Error('the GPU offers fewer than 10 storage buffers per stage');
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  const P = pipelines(device);
  const n = w * h;
  const U = GPUBufferUsage;
  // Buffers stay with the device between passes and tiles (one tile at a time per worker), grown
  // when a pass needs more: no per-pass allocation or zero-fill of the cost volumes.
  let pool = pools.get(device);
  if (!pool) pools.set(device, (pool = new Map()));
  const buf = (name, size, usage) => {
    let e = pool.get(name);
    if (!e || e.size < size) {
      e?.b.destroy();
      const sz = Math.max(16, Math.ceil((size * 1.25) / 16) * 16);
      e = { b: device.createBuffer({ size: sz, usage }), size: sz };
      pool.set(name, e);
    }
    return e.b;
  };
  const up = (name, arr, usage = U.STORAGE | U.COPY_DST) => {
    const b = buf(name, arr.byteLength, usage);
    device.queue.writeBuffer(b, 0, arr.buffer, arr.byteOffset, arr.byteLength);
    return b;
  };
  const sentinel = (a) => {
    const o = new Float32Array(n);
    for (let k = 0; k < n; k++) o[k] = Number.isFinite(a[k]) ? a[k] : -1e30;
    return o;
  };
  const bL = up('l', sentinel(left));
  const bR = up('r', sentinel(right));
  const cL = buf('cl', 12 * n, U.STORAGE);
  const cR = buf('cr2', 12 * n, U.STORAGE | U.COPY_SRC); // also carries the right disparities back
  const bLo = up('lo', Int32Array.from(lo));
  const bLen = up('len', Uint32Array.from(len));
  const bOff = up('off', Uint32Array.from(off));
  const bCost = buf('cost', 2 * total, U.STORAGE);
  const bAgg = buf('agg', 2 * total, U.STORAGE);
  const bRes = buf('res', 12 * n, U.STORAGE | U.COPY_SRC);
  const read = buf('read', 12 * n, U.MAP_READ | U.COPY_DST);
  const uni = buf('uni', 48, U.UNIFORM | U.COPY_DST);
  const ua = new ArrayBuffer(48);
  new Uint32Array(ua).set([w, h, p.census[0], p.census[1], p.p1, p.p2]);
  new Float32Array(ua)[6] = p.uniqueness;
  let dminG = Infinity;
  let dmaxG = -Infinity;
  for (let i = 0; i < n; i++) {
    if (lo[i] < dminG) dminG = lo[i];
    if (lo[i] + len[i] - 1 > dmaxG) dmaxG = lo[i] + len[i] - 1;
  }
  new Int32Array(ua).set([dminG, dmaxG], 7);
  device.queue.writeBuffer(uni, 0, ua);
  const g0 = device.createBindGroup({ layout: P.layout, entries: [uni, bL, bR, cL, cR, bLo, bLen, bOff, bCost, bAgg, bRes].map((b, k) => ({ binding: k, resource: { buffer: b } })) });
  let enc = device.createCommandEncoder();
  // With T.profile each stage is submitted and awaited on its own (diagnostics only).
  const stage = async (name) => {
    if (!T.profile) return;
    device.queue.submit([enc.finish()]);
    const t0 = performance.now();
    await device.queue.onSubmittedWorkDone();
    T.stages[name] = (T.stages[name] ?? 0) + performance.now() - t0;
    enc = device.createCommandEncoder();
  };
  const dispatch = async (name, pipe, x, y = 1) => {
    const c = enc.beginComputePass();
    c.setPipeline(pipe);
    c.setBindGroup(0, g0);
    c.dispatchWorkgroups(x, y);
    c.end();
    await stage(name);
  };
  const wg = Math.ceil(n / 64);
  await stage('upload');
  await dispatch('census', P.census, wg);
  await dispatch('costs', P.costs, wg, 8); // eight lanes per pixel across its range
  await dispatch('aggregate', P.aggregate, w + h - 1, 8); // (scan line, path)
  // 16 pixels per workgroup on a 2-D grid: a 1024² tile needs 65 536, past 65 535 per dimension.
  await dispatch('wta', P.wta, 256, Math.ceil(n / 16 / 256));
  await dispatch('wtaRight', P.wtaRight, Math.min(65535, wg), Math.ceil(wg / 65535));
  enc.copyBufferToBuffer(bRes, 0, read, 0, 12 * n);
  const readR = buf('readR', 12 * n, U.MAP_READ | U.COPY_DST);
  enc.copyBufferToBuffer(cR, 0, readR, 0, 12 * n);
  device.queue.submit([enc.finish()]);
  const [oom, invalid] = [await device.popErrorScope(), await device.popErrorScope()];
  if (oom || invalid) {
    for (const e of pool.values()) e.b.destroy();
    pool.clear();
    throw new Error(`WebGPU: ${(oom ?? invalid).message}`);
  }
  await Promise.all([read.mapAsync(GPUMapMode.READ, 0, 12 * n), readR.mapAsync(GPUMapMode.READ, 0, 12 * n)]);
  const raw = new Uint32Array(read.getMappedRange(0, 12 * n).slice(0));
  read.unmap();
  const rawR = new Float32Array(readR.getMappedRange(0, 12 * n).slice(0));
  readR.unmap();
  const rdisp = new Float32Array(n);
  for (let i = 0; i < n; i++) rdisp[i] = rawR[3 * i];
  const f = new Float32Array(raw.buffer);
  const status = new Uint8Array(n);
  const disp = new Float32Array(n).fill(NaN);
  const margin = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    status[i] = raw[3 * i + 2];
    if (status[i] === 2) {
      disp[i] = f[3 * i];
      margin[i] = f[3 * i + 1];
    }
  }
  return { status, disp, margin, rdisp };
}

const flip = (a, w, h) => {
  const o = new a.constructor(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + (w - 1 - x)] = a[y * w + x];
  return o;
};

/** One pass with the post-processing of sgm.rs `sgm_pass`. */
async function sgmPass(device, left, right, w, h, loIn, hiIn, p, rightDisp) {
  const n = w * h;
  const lo = new Int32Array(n);
  const len = new Uint32Array(n);
  const off = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    let a = loIn[i];
    let b = Math.max(hiIn[i], loIn[i] + 2);
    if (b - a + 1 > MAX_RANGE) {
      const c = Math.trunc((a + b) / 2);
      a = c - MAX_RANGE / 2;
      b = a + MAX_RANGE - 1;
    }
    lo[i] = a;
    len[i] = b - a + 1;
    off[i + 1] = off[i] + len[i] + (len[i] & 1); // ranges start on even entries (16-bit pairs)
  }
  const t0 = performance.now();
  const g = await gpuPass(device, left, right, w, h, lo, len, off, off[n], p);
  const t1 = performance.now();
  T.gpu += t1 - t0;
  const fom = new Uint8Array(n);
  let disp = g.disp;
  const conf = g.margin;
  for (let i = 0; i < n; i++) fom[i] = g.status[i] === 2 ? FOM.MATCHED : g.status[i] === 1 ? FOM.AMBIGUOUS : FOM.NODATA;
  // 'volume': right disparities from the left volume, 3 × 3 median filtered.
  if (rightDisp === 'volume') rightDisp = median3(g.rdisp, w, h);
  if (rightDisp)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (fom[i] !== FOM.MATCHED) continue;
        const xr = Math.round(x + disp[i]);
        const r = xr >= 0 && xr < w ? rightDisp[y * w + xr] : NaN;
        if (!(Number.isFinite(r) && Math.abs(r - disp[i]) <= p.lrTol)) {
          fom[i] = FOM.LR;
          disp[i] = NaN;
        }
      }
  // 3 × 3 median of the matched disparities.
  const med = disp.slice();
  const v = new Float32Array(9);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!Number.isFinite(disp[i])) continue;
      let m = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const q = disp[i + dy * w + dx];
          if (q === q) {
            // Insertion into the sorted run (at most nine values).
            let j = m++;
            while (j > 0 && v[j - 1] > q) {
              v[j] = v[j - 1];
              j--;
            }
            v[j] = q;
          }
        }
      if (m >= 5) med[i] = v[m >> 1];
    }
  disp = med;
  // Speckles: 4-connected segments with |Δd| ≤ 1 smaller than the limit.
  const seen = new Uint8Array(n);
  const stack = [];
  const seg = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (seen[s0] || !Number.isFinite(disp[s0])) continue;
    seg.length = 0;
    stack.push(s0);
    seen[s0] = 1;
    while (stack.length) {
      const i = stack.pop();
      seg.push(i);
      const x = i % w;
      const y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1])
        if (j >= 0 && !seen[j] && Number.isFinite(disp[j]) && Math.abs(disp[j] - disp[i]) <= 1) {
          seen[j] = 1;
          stack.push(j);
        }
    }
    if (seg.length < p.speckle)
      for (const i of seg) {
        disp[i] = NaN;
        fom[i] = FOM.SPECKLE;
      }
  }
  for (let i = 0; i < n; i++) if (fom[i] === FOM.MATCHED && Number.isFinite(disp[i])) fom[i] = FOM.MATCHED + Math.trunc(Math.min(1, conf[i] / 0.5) * 96);
  const estimate = new Float32Array(n);
  for (let i = 0; i < n; i++) estimate[i] = lo[i] + (len[i] - 1) / 2;
  T.post += performance.now() - t1;
  return { disparity: disp, fom, estimate };
}

function median3(a, w, h) {
  const out = a.slice();
  const v = new Float32Array(9);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (a[i] !== a[i]) continue;
      let m = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const q = a[i + dy * w + dx];
          if (q === q) {
            let j = m++;
            while (j > 0 && v[j - 1] > q) {
              v[j] = v[j - 1];
              j--;
            }
            v[j] = q;
          }
        }
      if (m >= 5) out[i] = v[m >> 1];
    }
  return out;
}

/**
 * sgm.rs `sgm`. On the GPU the left-right check takes the right disparities from the left
 * volume by default (one aggregation instead of two); `p.lrPass` runs the Rust code's
 * right-referenced pass instead.
 */
async function sgm(device, left, right, w, h, lo, hi, p) {
  if (!p.lrPass) return sgmPass(device, left, right, w, h, lo, hi, p, 'volume');
  const n = w * h;
  const rlo = new Int32Array(n).fill(2147483647);
  const rhi = new Int32Array(n).fill(-2147483648);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const x0 = Math.max(0, x + lo[i]);
      const x1 = Math.min(w - 1, x + hi[i]);
      for (let xr = x0; xr <= x1; xr++) {
        const k = y * w + xr;
        if (lo[i] < rlo[k]) rlo[k] = lo[i];
        if (hi[i] > rhi[k]) rhi[k] = hi[i];
      }
    }
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (rlo[k] > rhi[k]) {
        rlo[k] = lo[k];
        rhi[k] = hi[k];
      }
    }
  }
  const rr = await sgmPass(device, flip(right, w, h), flip(left, w, h), w, h, flip(rlo, w, h), flip(rhi, w, h), p, null);
  return sgmPass(device, left, right, w, h, lo, hi, p, flip(rr.disparity, w, h));
}

function downsample(img, w, h, f) {
  const ow = Math.floor(w / f);
  const oh = Math.floor(h / f);
  const out = new Float32Array(ow * oh).fill(NaN);
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      let s = 0;
      let c = 0;
      for (let dy = 0; dy < f; dy++)
        for (let dx = 0; dx < f; dx++) {
          const v = img[(y * f + dy) * w + x * f + dx];
          if (Number.isFinite(v)) {
            s += v;
            c++;
          }
        }
      if (c * 2 >= f * f) out[y * ow + x] = s / c;
    }
  return { img: out, w: ow, h: oh };
}

async function sgmPyramid(device, left, right, w, h, dmin, dmax, f, radius, p) {
  const L = downsample(left, w, h, f);
  const R = downsample(right, w, h, f);
  const cw = L.w;
  const ch = L.h;
  const loC = Math.floor(dmin / f) - 1;
  const hiC = Math.ceil(dmax / f) + 1;
  const coarse = await sgm(device, L.img, R.img, cw, ch, new Int32Array(cw * ch).fill(loC), new Int32Array(cw * ch).fill(hiC), { ...p, speckle: Math.max(4, Math.floor(p.speckle / (f * f))) });
  const cmin = new Float32Array(cw * ch).fill(NaN);
  const cmax = new Float32Array(cw * ch).fill(NaN);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      let a = Infinity;
      let b = -Infinity;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) continue;
          const v = coarse.disparity[yy * cw + xx];
          if (Number.isFinite(v)) {
            a = Math.min(a, v);
            b = Math.max(b, v);
          }
        }
      if (Number.isFinite(a)) {
        cmin[y * cw + x] = a;
        cmax[y * cw + x] = b;
      }
    }
  const lo = new Int32Array(w * h).fill(dmin);
  const hi = new Int32Array(w * h).fill(dmax);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = Math.min(Math.floor(y / f), ch - 1) * cw + Math.min(Math.floor(x / f), cw - 1);
      if (Number.isFinite(cmin[k])) {
        lo[y * w + x] = Math.max(Math.floor(cmin[k] * f) - radius, dmin - radius);
        hi[y * w + x] = Math.min(Math.ceil(cmax[k] * f) + radius, dmax + radius);
      }
    }
  return sgm(device, left, right, w, h, lo, hi, p);
}

/** dsm.rs `warp_affine`: tile pixel (u, v) (centre +0.5) → image a·(u, v, 1), bilinear; NaN outside. */
function warpAffine(src, sw, sh, sx0, sy0, a, w, h) {
  const out = new Float32Array(w * h).fill(NaN);
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      const uu = u + 0.5;
      const vv = v + 0.5;
      const fx = a[0] + a[1] * uu + a[2] * vv - sx0 - 0.5;
      const fy = a[3] + a[4] * uu + a[5] * vv - sy0 - 0.5;
      if (fx < 0 || fy < 0 || fx > sw - 1 || fy > sh - 1) continue;
      const i = Math.min(Math.floor(fx), sw - 2);
      const j = Math.min(Math.floor(fy), sh - 2);
      const ax = fx - i;
      const ay = fy - j;
      const k = j * sw + i;
      out[v * w + u] = src[k] * (1 - ax) * (1 - ay) + src[k + 1] * ax * (1 - ay) + src[k + sw] * (1 - ax) * ay + src[k + sw + 1] * ax * ay;
    }
  return out;
}

/**
 * The `dsmTile` op on the GPU (same `prm` record as the Rust op; SGM engine only). Returns
 * {matched, pixels, sum, count, fomM, fomU}, or null when WebGPU is not available.
 */
export async function gpuDsmTile(prm, left, right, n) {
  const g = await gpuDevice();
  if (!g) return null;
  const a = prm;
  const w = a[0];
  const h = a[1];
  const AL = Array.from(a.slice(2, 8));
  const AR = Array.from(a.slice(8, 14));
  const [lx0, ly0, lw, lh, rx0, ry0, rw, rh] = Array.from(a.slice(14, 22));
  const [dmin, dmax] = [Math.trunc(a[22]), Math.trunc(a[23])];
  const pyr = Math.max(1, Math.trunc(a[24]));
  const radius = Math.max(1, Math.trunc(a[25]));
  const p = { p1: a[26], p2: a[27], uniqueness: a[28], lrTol: a[29], speckle: a[30], census: [Math.min(4, Math.max(1, a[40])), Math.min(3, Math.max(1, a[41]))] };
  const [gu, gv, gd] = [a[31], a[32], a[33]];
  const grid = { lat0: a[34], lon0: a[35], dlat: a[36], dlon: a[37], nx: a[38], ny: a[39] };
  const hdr = (a.length - 42) % 3 === 0 ? 42 : 43;
  if (hdr === 43 && a[42] !== 0) return null; // NCC Fast stays in the worker
  if (w * h > 4096 * 4096 || a.length !== hdr + gu * gv * gd * 3 || left.length !== lw * lh || right.length !== rw * rh || dmax <= dmin) throw new Error('DSM tile: inconsistent sizes');
  const lt = warpAffine(left, lw, lh, lx0, ly0, AL, w, h);
  const rt = warpAffine(right, rw, rh, rx0, ry0, AR, w, h);
  const r = await sgmPyramid(g.device, lt, rt, w, h, dmin, dmax, pyr, radius, p);
  // Lookup (u, v, d) → (lat, lon, h), trilinear (dsm.rs Lut::at).
  const lut = a.subarray(hdr);
  const at = (u, v, d, out) => {
    const fu = Math.min(Math.max((u / w) * (gu - 1), 0), gu - 1);
    const fv = Math.min(Math.max((v / h) * (gv - 1), 0), gv - 1);
    const fd = Math.min(Math.max(((d - dmin) / Math.max(dmax - dmin, 1e-9)) * (gd - 1), 0), gd - 1);
    const i = Math.min(Math.floor(fu), gu - 2);
    const j = Math.min(Math.floor(fv), gv - 2);
    const k = Math.min(Math.floor(fd), gd - 2);
    const [ea, eb, ec] = [fu - i, fv - j, fd - k];
    out[0] = out[1] = out[2] = 0;
    for (let dk = 0; dk < 2; dk++)
      for (let dj = 0; dj < 2; dj++)
        for (let di = 0; di < 2; di++) {
          const wgt = (di ? ea : 1 - ea) * (dj ? eb : 1 - eb) * (dk ? ec : 1 - ec);
          const q = 3 * (((k + dk) * gv + j + dj) * gu + i + di);
          out[0] += wgt * lut[q];
          out[1] += wgt * lut[q + 1];
          out[2] += wgt * lut[q + 2];
        }
  };
  const sum = new Float32Array(n);
  const count = new Float32Array(n);
  const fomM = new Uint8Array(n);
  const fomU = new Uint8Array(n);
  let matched = 0;
  let pixels = 0;
  const q = [0, 0, 0];
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      const i = v * w + u;
      const f = r.fom[i];
      if (f === 0) continue;
      pixels++;
      const isM = f >= FOM.MATCHED && Number.isFinite(r.disparity[i]);
      at(u + 0.5, v + 0.5, isM ? r.disparity[i] : r.estimate[i], q);
      const ix = Math.round((q[1] - grid.lon0) / grid.dlon);
      const iy = Math.round((grid.lat0 - q[0]) / grid.dlat);
      if (ix < 0 || iy < 0 || ix >= grid.nx || iy >= grid.ny) continue;
      const k = iy * grid.nx + ix;
      if (isM) {
        matched++;
        sum[k] += q[2];
        count[k] += 1;
        if (f > fomM[k]) fomM[k] = f;
      } else if (f > fomU[k]) fomU[k] = f;
    }
  return { matched, pixels, sum, count, fomM, fomU, engine: 'webgpu', timing: { ...T, stages: { ...T.stages } } };
}
