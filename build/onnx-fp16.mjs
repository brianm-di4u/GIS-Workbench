// ONNX model conversion for the WebGPU runtime (REQ-GAP-56, spike S-33): the dynamic-int8 graphs
// of the AI packs (DynamicQuantizeLinear → MatMulInteger / ConvInteger → Cast → Mul) fall back to
// the CPU on WebGPU. This rewrites each quantised MatMul / Conv back to a float one with its
// weight dequantised ((q − zero point) × scale, so the weights carry exactly the int8 values),
// then converts the graph to float16: float initializers and Constant tensors become float16,
// Cast-to-float casts to float16, the float inputs are cast to float16 on entry and the outputs
// back to float32 on exit (the session's inputs and outputs stay float32). Tensors that an op
// needs in float32 (Resize roi and scales) stay float32. value_info is dropped and re-inferred
// by the runtime. Deterministic: the same input gives the same bytes.
//
//   node build/onnx-fp16.mjs in.onnx out.onnx [--data in.onnx_data] [--fp32]
//
// The ONNX schema subset is build/onnx/onnx.proto (Apache-2.0, ONNX project).

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', 'package.json'));
const pb = require('protobufjs');

const FLOAT = 1;
const INT8 = 3;
const UINT8 = 2;
const FLOAT16 = 10;

let types = null;
function proto() {
  types ??= (() => {
    const root = pb.loadSync(join(here, 'onnx', 'onnx.proto'));
    return { Model: root.lookupType('onnx.ModelProto'), Tensor: root.lookupType('onnx.TensorProto') };
  })();
  return types;
}

export function decodeModel(bytes) {
  return proto().Model.decode(bytes);
}
export function encodeModel(model) {
  const { Model } = proto();
  return Buffer.from(Model.encode(Model.fromObject(Model.toObject(model, { longs: String, bytes: Buffer, defaults: false }))).finish());
}

const F1 = new Float32Array(1);
const U1 = new Uint32Array(F1.buffer);
/** f32 → f16 bits (round to nearest even), with overflow to ±inf and subnormals. */
export function f16bits(v) {
  F1[0] = v;
  const x = U1[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let m = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    m |= 0x800000;
    const shift = 14 - e;
    let r = m >> shift;
    const rem = m & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && r & 1)) r++;
    return sign | r;
  }
  let r = (e << 10) | (m >> 13);
  const rem = m & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && r & 1)) r++;
  return sign | r;
}

/** A tensor's values as Float32Array / Int8Array … (raw_data, typed fields or external data). */
function tensorValues(t, external) {
  let raw = t.rawData?.length ? t.rawData : null;
  if (t.dataLocation === 1) {
    const kv = Object.fromEntries(t.externalData.map((e) => [e.key, e.value]));
    if (!external) throw new Error(`${t.name} is in external data; pass --data`);
    const off = Number(kv.offset ?? 0);
    const len = Number(kv.length ?? external.length - off);
    raw = external.subarray(off, off + len);
  }
  const n = t.dims.reduce((a, d) => a * Number(d), 1);
  if (t.dataType === FLOAT) return raw ? new Float32Array(Uint8Array.from(raw).buffer, 0, n) : Float32Array.from(t.floatData);
  if (t.dataType === INT8) return raw ? new Int8Array(Uint8Array.from(raw).buffer, 0, n) : Int8Array.from(t.int32Data);
  if (t.dataType === UINT8) return raw ? new Uint8Array(Uint8Array.from(raw).buffer, 0, n) : Uint8Array.from(t.int32Data);
  throw new Error(`${t.name}: data type ${t.dataType} not handled`);
}

function setRaw(t, dataType, bytes) {
  t.dataType = dataType;
  t.rawData = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  t.floatData = [];
  t.int32Data = [];
  t.externalData = [];
  t.dataLocation = 0;
}

/**
 * Replace every dynamic-int8 MatMulInteger / ConvInteger chain by a float MatMul / Conv with the
 * dequantised weight. Inlines external data. Returns {model, replaced}.
 */
export function dequantizeDynamic(model, external = null) {
  const g = model.graph;
  const inits = new Map(g.initializer.map((t) => [t.name, t]));
  const byOut = new Map();
  const users = new Map();
  for (const n of g.node) {
    for (const o of n.output) byOut.set(o, n);
    for (const i of n.input) (users.get(i) ?? users.set(i, []).get(i)).push(n);
  }
  const drop = new Set();
  const added = new Map(); // replaced node → new node
  const newInits = [];
  let replaced = 0;
  for (const q of g.node) {
    if (q.opType !== 'MatMulInteger' && q.opType !== 'ConvInteger') continue;
    const dql = byOut.get(q.input[0]);
    if (dql?.opType !== 'DynamicQuantizeLinear') throw new Error(`${q.name}: activation is not dynamically quantised`);
    const wq = inits.get(q.input[1]);
    if (!wq) throw new Error(`${q.name}: weight is not an initializer`);
    const wzp = q.input[3] ? inits.get(q.input[3]) : null;
    const cast = (users.get(q.output[0]) ?? [])[0];
    if (cast?.opType !== 'Cast') throw new Error(`${q.name}: no Cast after the integer op`);
    const fin = (users.get(cast.output[0]) ?? [])[0];
    if (fin?.opType !== 'Mul') throw new Error(`${q.name}: no scale Mul`);
    const scaleName = fin.input.find((x) => x !== cast.output[0]);
    const sm = byOut.get(scaleName);
    if (sm?.opType !== 'Mul') throw new Error(`${q.name}: the scale is not a Mul of the two scales`);
    const wsName = sm.input.find((x) => x !== dql.output[1]);
    const ws = inits.get(wsName);
    if (!ws) throw new Error(`${q.name}: weight scale is not an initializer`);
    const W = tensorValues(wq, external);
    const S = tensorValues(ws, external);
    const Z = wzp ? tensorValues(wzp, external) : new Int8Array([0]);
    const dims = wq.dims.map(Number);
    const out = new Float32Array(W.length);
    // Per-tensor or per-channel (the last axis for MatMul, the first for Conv).
    const perC = S.length > 1;
    const chans = q.opType === 'ConvInteger' ? dims[0] : dims.at(-1);
    const inner = W.length / chans;
    for (let i = 0; i < W.length; i++) {
      const c = !perC ? 0 : q.opType === 'ConvInteger' ? Math.floor(i / inner) : i % chans;
      out[i] = (W[i] - (Z.length > 1 ? Z[c] : Z[0])) * (perC ? S[c] : S[0]);
    }
    const wf = { name: `${wq.name}_dequantized`, dims: wq.dims, dataType: FLOAT, rawData: Buffer.from(out.buffer), externalData: [], dataLocation: 0 };
    newInits.push(wf);
    const node = { input: [dql.input[0], wf.name], output: [fin.output[0]], name: `${q.name || fin.output[0]}_float`, opType: q.opType === 'ConvInteger' ? 'Conv' : 'MatMul', domain: '', attribute: q.opType === 'ConvInteger' ? q.attribute : [] };
    added.set(q, node);
    for (const n of [q, cast, fin, sm]) drop.add(n);
    replaced++;
  }
  // DequantizeLinear of initializers (static weights): folded into a float initializer.
  for (const n of g.node) {
    if (n.opType !== 'DequantizeLinear' || drop.has(n)) continue;
    const [xq, xs, xz] = n.input.map((x) => inits.get(x));
    if (!xq || !xs) continue;
    const X = tensorValues(xq, external);
    const S = tensorValues(xs, external);
    const Z = xz ? tensorValues(xz, external) : new Int8Array([0]);
    if (S.length > 1 || Z.length > 1) {
      const axisA = n.attribute.find((a) => a.name === 'axis');
      const dims = xq.dims.map(Number);
      const axis = axisA ? (Number(axisA.i) + dims.length) % dims.length : 1;
      const inner = dims.slice(axis + 1).reduce((a, b) => a * b, 1);
      const out = new Float32Array(X.length);
      for (let i = 0; i < X.length; i++) {
        const c = Math.floor(i / inner) % dims[axis];
        out[i] = (X[i] - (Z.length > 1 ? Z[c] : Z[0])) * (S.length > 1 ? S[c] : S[0]);
      }
      newInits.push({ name: n.output[0], dims: xq.dims, dataType: FLOAT, rawData: Buffer.from(out.buffer), externalData: [], dataLocation: 0 });
    } else {
      const out = Float32Array.from(X, (v) => (v - Z[0]) * S[0]);
      newInits.push({ name: n.output[0], dims: xq.dims, dataType: FLOAT, rawData: Buffer.from(out.buffer), externalData: [], dataLocation: 0 });
    }
    drop.add(n);
    replaced++;
  }
  // A DynamicQuantizeLinear goes when nothing that stays uses its outputs.
  for (const n of g.node) {
    if (n.opType !== 'DynamicQuantizeLinear') continue;
    const used = n.output.some((o) => (users.get(o) ?? []).some((u) => !drop.has(u)));
    if (!used) drop.add(n);
  }
  g.node = g.node.flatMap((n) => (added.has(n) ? [added.get(n)] : drop.has(n) ? [] : [n]));
  const stillUsed = new Set(g.node.flatMap((n) => n.input));
  for (const o of g.output) stillUsed.add(o.name);
  g.initializer = [...g.initializer.filter((t) => stillUsed.has(t.name)), ...newInits];
  // Inline what is left of the external data.
  for (const t of g.initializer) {
    if (t.dataLocation !== 1) continue;
    const v = tensorValues(t, external);
    setRaw(t, t.dataType, v);
  }
  return { model, replaced };
}

/** Inputs that must stay float32 when the graph is float16: op type → input indices. */
const KEEP_F32 = { Resize: [1, 2], Upsample: [1], DequantizeLinear: [1] };
/** Ops whose output stays float32 (opset < 19): a Cast to float16 follows them. */
const OUT_F32 = new Set(['DequantizeLinear']);

/** Convert a float32 graph to float16 with float32 inputs and outputs. Returns {model, converted}. */
export function toFloat16(model) {
  const g = model.graph;
  const keep = new Set();
  for (const n of g.node) for (const k of KEEP_F32[n.opType] ?? []) if (n.input[k]) keep.add(n.input[k]);
  let converted = 0;
  for (const t of g.initializer) {
    if (t.dataType !== FLOAT || keep.has(t.name)) continue;
    const v = tensorValues(t, null);
    setRaw(t, FLOAT16, Uint16Array.from(v, f16bits));
    converted++;
  }
  for (const n of g.node) {
    if (n.opType === 'Constant' && !keep.has(n.output[0])) {
      for (const a of n.attribute) if (a.t && a.t.dataType === FLOAT) setRaw(a.t, FLOAT16, Uint16Array.from(tensorValues(a.t, null), f16bits));
    }
    if (n.opType === 'ConstantOfShape') for (const a of n.attribute) if (a.t && a.t.dataType === FLOAT) setRaw(a.t, FLOAT16, Uint16Array.from(tensorValues(a.t, null), f16bits));
    if (n.opType === 'Cast' && !keep.has(n.output[0])) for (const a of n.attribute) if (a.name === 'to' && Number(a.i) === FLOAT) a.i = FLOAT16;
    if (n.opType === 'EyeLike' || n.opType === 'RandomNormalLike') throw new Error(`${n.opType} is not handled`);
  }
  // Ops that still produce float32 (a DequantizeLinear of an activation): cast after them.
  const after = [];
  for (const n of g.node) {
    if (!OUT_F32.has(n.opType)) continue;
    const y = n.output[0];
    n.output[0] = `${y}__f32`;
    after.push([n, { input: [n.output[0]], output: [y], name: `${y}__to_fp16`, opType: 'Cast', domain: '', attribute: [{ name: 'to', type: 2, i: FLOAT16 }] }]);
  }
  if (after.length) {
    const m = new Map(after);
    g.node = g.node.flatMap((n) => (m.has(n) ? [n, m.get(n)] : [n]));
  }
  // Float inputs: cast to float16 on entry.
  const head = [];
  for (const inp of g.input) {
    if (inp.type?.tensorType?.elemType !== FLOAT) continue;
    const to = `${inp.name}__fp16`;
    for (const n of g.node) n.input = n.input.map((x) => (x === inp.name ? to : x));
    head.push({ input: [inp.name], output: [to], name: `${inp.name}__to_fp16`, opType: 'Cast', domain: '', attribute: [{ name: 'to', type: 2, i: FLOAT16 }] });
  }
  // Float outputs: produced as float16 under a new name, cast back.
  const tail = [];
  for (const out of g.output) {
    if (out.type?.tensorType?.elemType !== FLOAT) continue;
    const from = `${out.name}__fp16`;
    for (const n of g.node) n.output = n.output.map((x) => (x === out.name ? from : x));
    for (const n of g.node) n.input = n.input.map((x) => (x === out.name ? from : x));
    tail.push({ input: [from], output: [out.name], name: `${out.name}__to_fp32`, opType: 'Cast', domain: '', attribute: [{ name: 'to', type: 2, i: FLOAT }] });
  }
  g.node = [...head, ...g.node, ...tail];
  g.valueInfo = [];
  return { model, converted };
}

const DOUBLE = 11;
/**
 * WebGPU has no float64: casts to double and double constants become `target` (float or float16).
 * OWLv2's class head masks its logits with a Where on doubles, which the WebGPU runtime cannot
 * place on any device. Returns the number of nodes changed.
 */
export function noDouble(model, target = FLOAT) {
  let n = 0;
  for (const node of model.graph.node) {
    if (node.opType === 'Cast') {
      for (const a of node.attribute) {
        if (a.name === 'to' && Number(a.i) === DOUBLE) {
          a.i = target;
          n++;
        }
      }
    }
    if (node.opType === 'Constant') {
      for (const a of node.attribute) {
        if (a.t?.dataType !== DOUBLE) continue;
        const raw = a.t.rawData?.length ? new Float64Array(Uint8Array.from(a.t.rawData).buffer) : Float64Array.from(a.t.doubleData ?? []);
        const f = Float32Array.from(raw, (v) => Math.max(-3.4e38, Math.min(3.4e38, v)));
        if (target === FLOAT16) setRaw(a.t, FLOAT16, Uint16Array.from(f, f16bits));
        else setRaw(a.t, FLOAT, f);
        a.t.doubleData = [];
        n++;
      }
    }
  }
  return n;
}

/** int8 model bytes (+ external data) → {bytes, replaced, converted, doubles}; fp32: stop after dequantising. */
export function convertModel(bytes, external = null, { fp32 = false } = {}) {
  const m = decodeModel(bytes);
  const d = dequantizeDynamic(m, external);
  const doubles = noDouble(m, fp32 ? FLOAT : FLOAT16);
  const f = fp32 ? { converted: 0 } : toFloat16(m);
  return { bytes: encodeModel(m), replaced: d.replaced, converted: f.converted, doubles };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [inp, out] = process.argv.slice(2).filter((a) => !a.startsWith('--') && !process.argv[process.argv.indexOf(a) - 1]?.startsWith('--data'));
  const di = process.argv.indexOf('--data');
  const ext = di > 0 ? readFileSync(process.argv[di + 1]) : null;
  const t0 = Date.now();
  const r = convertModel(readFileSync(inp), ext, { fp32: process.argv.includes('--fp32') });
  writeFileSync(out, r.bytes);
  console.log(`${out}: ${r.replaced} quantised ops dequantised, ${r.doubles} double ops to float, ${r.converted} initializers to float16, ${(r.bytes.length / 1048576).toFixed(1)} MB, ${Date.now() - t0} ms`);
}
