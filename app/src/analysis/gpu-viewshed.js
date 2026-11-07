// WebGPU viewshed (REQ-PRF-07): the worker's reference-plane algorithm (gw-terrain viewshed.rs,
// Wang, Robinson & White 2000) on the GPU. Rings of Chebyshev radius r depend only on ring r − 1,
// so each ring is one dispatch over its 8r posts, all rings in one compute pass. Heights are f32
// (the worker uses f64 for the sight lines): posts within a few millimetres of their sight line
// may differ. Same parameters and output as the worker op: u8 per post, 0/1 (or counts for
// several observers), 255 outside.

const WGSL = /* wgsl */ `
struct P {
  w: i32, h: i32, ox: i32, oy: i32, r: i32, fan: i32, pad0: i32, pad1: i32,
  cx: f32, cy: f32, zo: f32, th: f32, cc: f32, minD: f32, maxD: f32, azS: f32, azE: f32,
};
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> z: array<f32>;
@group(0) @binding(2) var<storage, read_write> hz: array<f32>;
@group(0) @binding(3) var<storage, read_write> outv: array<u32>;
const NONE: f32 = -1e30;
fn ok(v: f32) -> bool { return v > -1e29; }
fn hget(x: i32, y: i32) -> f32 {
  if (x < 0 || y < 0 || x >= p.w || y >= p.h) { return NONE; }
  return hz[u32(y * p.w + x)];
}
@compute @workgroup_size(64)
fn ring(@builtin(global_invocation_id) id: vec3<u32>) {
  let r = p.r;
  let t = i32(id.x);
  if (t >= 8 * r) { return; }
  let side = t / (2 * r);
  let off = t % (2 * r);
  var dx: i32; var dy: i32;
  if (side == 0) { dx = -r + off; dy = -r; }
  else if (side == 1) { dx = r; dy = -r + off; }
  else if (side == 2) { dx = r - off; dy = r; }
  else { dx = -r; dy = r - off; }
  let x = p.ox + dx;
  let y = p.oy + dy;
  if (x < 0 || y < 0 || x >= p.w || y >= p.h) { return; }
  let k = u32(y * p.w + x);
  let zr = z[k];
  if (!ok(zr)) { return; }
  let fx = f32(dx) * p.cx;
  let fy = f32(dy) * p.cy;
  let d2 = fx * fx + fy * fy;
  let zc = zr - p.cc * d2 / (2.0 * 6370000.0);
  let ai = max(abs(dx), abs(dy));
  let aj = min(abs(dx), abs(dy));
  let sx = sign(dx);
  let sy = sign(dy);
  var hline = p.zo;
  var vis = true;
  if (ai > 1) {
    var ax = x - sx; var ay = y; var bx = x - sx; var by = y - sy;
    if (abs(dx) < abs(dy)) { ax = x; ay = y - sy; }
    let ha = hget(ax, ay);
    let hb = hget(bx, by);
    let tt = f32(aj) / f32(ai);
    var hc = NONE;
    if (ok(ha) && ok(hb)) { hc = ha * (1.0 - tt) + hb * tt; }
    else if (ok(ha)) { hc = ha; }
    else if (ok(hb)) { hc = hb; }
    if (ok(hc)) {
      hline = p.zo + (hc - p.zo) * f32(ai) / f32(ai - 1);
      vis = zc + p.th >= hline;
    } else {
      hline = NONE;
    }
  }
  hz[k] = select(max(zc, hline), zc, ai == 1);
  let dist = sqrt(d2);
  var inr = dist >= p.minD && (p.maxD <= 0.0 || dist <= p.maxD);
  if (inr && p.fan == 1) {
    let az = (degrees(atan2(fx, -fy)) + 360.0) % 360.0;
    if (p.azS <= p.azE) { inr = az >= p.azS && az <= p.azE; } else { inr = az >= p.azS || az <= p.azE; }
  }
  outv[k] = select(select(0u, 1u, vis), 255u, !inr);
}
`;

let devP = null;
/** The shared WebGPU device, or null where WebGPU is not available. */
export function gpuDevice() {
  devP ??= (async () => {
    if (!globalThis.navigator?.gpu) return null;
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return null;
    const d = await a.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: Math.min(a.limits.maxStorageBufferBindingSize, 1 << 30), maxBufferSize: Math.min(a.limits.maxBufferSize, 1 << 30), maxStorageBuffersPerShaderStage: Math.min(a.limits.maxStorageBuffersPerShaderStage, 10) } });
    d.lost.then(() => {
      devP = null;
    });
    return { device: d, adapter: a, info: a.info ?? {} };
  })().catch(() => null);
  return devP;
}

const pipes = new WeakMap();
function pipeline(device) {
  let pl = pipes.get(device);
  if (!pl) {
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 80 } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const module = device.createShaderModule({ code: WGSL });
    pl = { layout, pipe: device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint: 'ring' } }) };
    pipes.set(device, pl);
  }
  return pl;
}

const norm = (a) => ((a % 360) + 360) % 360;

/** One observer on the GPU → Uint8Array (0/1/255). */
async function one(g, w, h, cx, cy, o, zbuf) {
  const { device } = g;
  const { layout, pipe } = pipeline(device);
  const [ox, oy, oh, th, cc, minD, maxD, azS, azE] = o;
  const n = w * h;
  const hz = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const out = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const read = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const zo = zbuf.host[oy * w + ox] + oh;
  const hz0 = new Float32Array(n).fill(-1e30);
  hz0[oy * w + ox] = zo;
  device.queue.writeBuffer(hz, 0, hz0);
  const o0 = new Uint32Array(n).fill(255);
  o0[oy * w + ox] = 1;
  device.queue.writeBuffer(out, 0, o0);
  const maxr = Math.max(ox, w - 1 - ox, oy, h - 1 - oy);
  const stride = 256;
  const uni = device.createBuffer({ size: Math.max(1, maxr) * stride, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const fan = Math.abs(azE - azS) < 1e-9 || Math.abs(azE - azS) >= 360 ? 0 : 1;
  const u = new ArrayBuffer(Math.max(1, maxr) * stride);
  for (let r = 1; r <= maxr; r++) {
    const iv = new Int32Array(u, (r - 1) * stride, 8);
    iv.set([w, h, ox, oy, r, fan, 0, 0]);
    new Float32Array(u, (r - 1) * stride + 32, 9).set([cx, cy, zo, th, cc, minD, maxD, norm(azS), norm(azE)]);
  }
  device.queue.writeBuffer(uni, 0, u);
  const bg = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uni, size: 80 } }, { binding: 1, resource: { buffer: zbuf.buf } }, { binding: 2, resource: { buffer: hz } }, { binding: 3, resource: { buffer: out } }] });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  for (let r = 1; r <= maxr; r++) {
    pass.setBindGroup(0, bg, [(r - 1) * stride]);
    pass.dispatchWorkgroups(Math.ceil((8 * r) / 64));
  }
  pass.end();
  enc.copyBufferToBuffer(out, 0, read, 0, n * 4);
  device.queue.submit([enc.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const v = new Uint8Array(n);
  const r32 = new Uint32Array(read.getMappedRange());
  for (let k = 0; k < n; k++) v[k] = r32[k];
  read.unmap();
  for (const b of [hz, out, read, uni]) b.destroy();
  return v;
}

/**
 * Viewshed on the GPU with the worker op's parameters (`prm` = [w, h, cell x, cell y, then per
 * observer: column, row, observer h, target h, cc, min, max, az start, az end]; `z` = heights).
 * Returns null when WebGPU is unavailable or the grid is beyond the device's limits.
 */
export async function gpuViewshed(prm, z) {
  const g = await gpuDevice();
  if (!g) return null;
  const [w, h, cx, cy] = prm;
  const n = w * h;
  if (n * 4 > g.device.limits.maxStorageBufferBindingSize) return null;
  const host = new Float32Array(n);
  for (let k = 0; k < n; k++) host[k] = Number.isFinite(z[k]) ? z[k] : -1e30;
  const buf = g.device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  g.device.queue.writeBuffer(buf, 0, host);
  const zbuf = { buf, host };
  const obs = [];
  for (let i = 4; i + 9 <= prm.length; i += 9) obs.push(Array.from(prm.slice(i, i + 9)));
  let res = null;
  try {
    for (const o of obs) {
      if (!(host[o[1] * w + o[0]] > -1e29)) {
        // A void observer post: no sight lines from it.
        if (obs.length === 1) res = new Uint8Array(n).fill(255);
        continue;
      }
      const v = await one(g, w, h, cx, cy, o, zbuf);
      if (obs.length === 1) {
        res = v;
        break;
      }
      res ??= new Uint8Array(n).fill(255);
      for (let k = 0; k < n; k++) if (v[k] !== 255) res[k] = (res[k] === 255 ? 0 : res[k]) + v[k];
    }
  } finally {
    buf.destroy();
  }
  return res ?? new Uint8Array(n).fill(255);
}
