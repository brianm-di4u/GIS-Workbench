// REQ-GAP-57 security suite for user-supplied ONNX models: the descriptor is data (unknown keys,
// markup and bad specs refused), the file must match its declared SHA-256, the licence must pass
// the same gate as the model packs (REQ-LAI-08; YOLO-World, SuperPoint and Qwen2.5-VL-3B refused),
// only standard operator domains run, no external data; and the output decoders.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { validateDescriptor, checkUserModel, inspectOnnx, licenceIssues, MODEL_LICENCES as APP_LICENCES, LANDCOVER } from '../../app/src/ai/user-models.js';
import { MODEL_LICENCES, modelLicenceGate } from '../../build/gates.mjs';
import { decodeDetections, classify } from '../../app/src/workers/ai/user-model.js';

const require = createRequire(import.meta.url);
const pb = require('protobufjs');
const root = pb.loadSync('build/onnx/onnx.proto');
const Model = root.lookupType('onnx.ModelProto');

/** A tiny ONNX model: Identity(x) → y, with options for custom domains and external data. */
function onnx({ domain = '', external = false, opset = '' } = {}) {
  const m = {
    irVersion: 8,
    opsetImport: [{ domain: '', version: 17 }, ...(opset ? [{ domain: opset, version: 1 }] : [])],
    graph: {
      name: 'g',
      node: [{ input: ['x'], output: ['y'], opType: domain ? 'MyOp' : 'Identity', domain }],
      input: [{ name: 'x', type: { tensorType: { elemType: 1, shape: { dim: [{ dimValue: 1 }, { dimValue: 3 }, { dimValue: 32 }, { dimValue: 32 }] } } } }],
      output: [{ name: 'y', type: { tensorType: { elemType: 1 } } }],
      initializer: external ? [{ name: 'w', dims: [4], dataType: 1, dataLocation: 1, externalData: [{ key: 'location', value: 'w.bin' }] }] : [],
    },
  };
  return new Uint8Array(Model.encode(Model.fromObject(m)).finish());
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const desc = (bytes, extra = {}) => ({
  format: 'gw-model/1',
  id: 'roofs',
  name: 'Roof segmenter',
  task: 'segmentation',
  licence: { spdx: ['MIT'], text: 'MIT License' },
  sha256: sha(bytes),
  input: { size: [32, 32], channels: 3 },
  output: { format: 'logits' },
  classes: ['background', 'roof'],
  ...extra,
});

describe('REQ-GAP-57 user model descriptor', () => {
  it('accepts a good descriptor and fills defaults', () => {
    const d = validateDescriptor(desc(onnx()));
    expect(d.input).toMatchObject({ layout: 'NCHW', range: [0, 1], resize: 'stretch', channels: 3 });
    expect(d.threshold).toBe(0.5);
  });

  it('refuses unknown keys, markup and bad specs', () => {
    const b = onnx();
    const no = (extra, re, code = 'E_MODEL_DESCRIPTOR') => {
      let e;
      try {
        validateDescriptor(desc(b, extra));
      } catch (x) {
        e = x;
      }
      expect(e?.code).toBe(code);
      expect(e.message).toMatch(re);
    };
    no({ script: 'alert(1)' }, /unknown field script/);
    no({ onload: 'x' }, /unknown field onload/);
    no({ input: { size: [32, 32], url: 'https://x' } }, /input: unknown field url/);
    no({ name: '<img src=x onerror=alert(1)>' }, /no name/);
    no({ format: 'gw-model/2' }, /not a model descriptor/);
    no({ id: 'Bad Id' }, /model id/);
    no({ task: 'generation' }, /task must be/);
    no({ sha256: 'abc' }, /SHA-256/);
    no({ input: { size: [8000, 32] } }, /input.size/);
    no({ input: { size: [32, 32], channels: 4 } }, /channels/);
    no({ output: { format: 'yolov8' } }, /does not fit a segmentation model/);
    no({ classes: [] }, /classes must list/);
    no({ colors: [[0, 0]] }, /colors/);
  });

  it('refuses non-permissive licences and the models known to carry them', () => {
    const b = onnx();
    const lic = (licence, name) => {
      let e;
      try {
        validateDescriptor(desc(b, { licence, ...(name ? { name } : {}) }));
      } catch (x) {
        e = x;
      }
      return e;
    };
    expect(lic({ spdx: ['GPL-3.0-only'] })?.code).toBe('E_MODEL_LICENCE');
    expect(lic({ spdx: ['AGPL-3.0'] })?.message).toMatch(/not a permissive licence/);
    expect(lic({ spdx: ['CC-BY-NC-4.0'] })?.code).toBe('E_MODEL_LICENCE');
    expect(lic({ spdx: ['MIT'], text: 'weights for research only' })?.message).toMatch(/research only/);
    expect(lic({ spdx: ['Apache-2.0'], text: 'Non-commercial use' })?.message).toMatch(/Non-commercial/i);
    expect(lic({ spdx: [] })?.message).toMatch(/no SPDX/);
    expect(lic({ spdx: ['MIT'] }, 'YOLO-World v2 small')?.message).toMatch(/YOLO-World is not permissively licensed/);
    expect(lic({ spdx: ['MIT'] }, 'SuperPoint keypoints')?.message).toMatch(/SuperPoint/);
    expect(lic({ spdx: ['Apache-2.0'] }, 'Qwen2.5-VL-3B instruct')?.message).toMatch(/Qwen2\.5-VL-3B/);
    expect(lic({ spdx: ['BSD-3-Clause', 'Apache-2.0'] })).toBeUndefined();
  });

  it('uses the same licence list as the build gate (REQ-LAI-08)', () => {
    expect([...APP_LICENCES].sort()).toEqual([...MODEL_LICENCES].sort());
    expect(licenceIssues({ spdx: ['MIT'], text: 'GPL' })).toHaveLength(1);
    expect(modelLicenceGate([{ pack: 'p', spdx: ['MIT'], licence: 'GPL' }])).toHaveLength(1);
    // The shipped land-cover model passes the same gate.
    expect(licenceIssues(LANDCOVER.licence, LANDCOVER.name)).toEqual([]);
  });
});

describe('REQ-GAP-57 user model file checks', () => {
  it('accepts a matching file and inspects its graph', async () => {
    const b = onnx();
    const r = await checkUserModel(desc(b), b);
    expect(r.info).toMatchObject({ inputs: ['x'], outputs: ['y'], external: 0 });
    expect(r.sha256).toBe(sha(b));
  });

  it('refuses a file whose hash differs (a changed byte)', async () => {
    const b = onnx();
    const d = desc(b);
    const c = b.slice();
    c[c.length - 1] ^= 1;
    await expect(checkUserModel(d, c)).rejects.toMatchObject({ code: 'E_MODEL_HASH' });
    await expect(checkUserModel({ ...d, size: b.length + 1 }, b)).rejects.toMatchObject({ code: 'E_MODEL_HASH' });
  });

  it('refuses custom operator domains, external data, missing tensors and non-ONNX bytes', async () => {
    const c1 = onnx({ domain: 'com.evil', opset: 'com.evil' });
    await expect(checkUserModel(desc(c1), c1)).rejects.toMatchObject({ code: 'E_MODEL_OPS' });
    const c2 = onnx({ external: true });
    await expect(checkUserModel(desc(c2), c2)).rejects.toMatchObject({ code: 'E_MODEL_EXTERNAL' });
    const c3 = onnx();
    await expect(checkUserModel(desc(c3, { input: { size: [32, 32], name: 'images' } }), c3)).rejects.toMatchObject({ code: 'E_MODEL_IO' });
    await expect(checkUserModel(desc(c3, { output: { format: 'logits', name: 'nope' } }), c3)).rejects.toMatchObject({ code: 'E_MODEL_IO' });
    const js = new TextEncoder().encode('<script>alert(1)</script>'.padEnd(64, ' '));
    await expect(checkUserModel(desc(js), js)).rejects.toMatchObject({ code: 'E_MODEL_FILE' });
    const ms = new Uint8Array([0x08, 0x08, 0x3a, 0xff, 0xff]);
    await expect(checkUserModel(desc(ms), ms)).rejects.toMatchObject({ code: 'E_MODEL_FILE' });
  });

  const LC = 'D:/gwb24/data-extai/sparsemask/onnx/model.onnx';
  it.skipIf(!existsSync(LC))('inspects the real land-cover model (12 MB) without a protobuf library', () => {
    const b = readFileSync(LC);
    const info = inspectOnnx(b);
    expect(info.inputs).toEqual(['input']);
    expect(info.outputs).toEqual(['output']);
    expect(info.external).toBe(0);
    expect(info.opsets.every((d) => ['', 'ai.onnx', 'com.microsoft'].includes(d))).toBe(true);
  });
});

describe('REQ-GAP-57 output decoding', () => {
  it('decodes YOLOv8 [1, 4 + C, N] boxes with per-class NMS', () => {
    const C = 2;
    const N = 4;
    const d = new Float32Array((4 + C) * N);
    const put = (i, cx, cy, w, h, s0, s1) => [cx, cy, w, h, s0, s1].forEach((v, k) => (d[k * N + i] = v));
    put(0, 10, 10, 4, 4, 0.9, 0.1);
    put(1, 10.5, 10, 4, 4, 0.8, 0.1); // overlaps 0, same class → suppressed
    put(2, 20, 20, 6, 6, 0.1, 0.7);
    put(3, 30, 30, 2, 2, 0.1, 0.2); // under the threshold
    const out = { output0: { dims: [1, 4 + C, N], data: d } };
    const r = decodeDetections(out, { classes: ['car', 'truck'], threshold: 0.25, output: { format: 'yolov8' }, input: { size: [64, 64] } }, { fx: 2, fy: 2, w: 128, h: 128 });
    expect(r.map((x) => x.cls)).toEqual(['car', 'truck']);
    expect(r[0].box).toEqual([16, 16, 24, 24]);
  });

  it('decodes boxes / scores / labels outputs, normalised', () => {
    const out = { b: { dims: [2, 4], data: new Float32Array([0.1, 0.1, 0.2, 0.2, 0.5, 0.5, 0.9, 0.9]) }, s: { dims: [2], data: new Float32Array([0.6, 0.1]) }, l: { dims: [2], data: new BigInt64Array([1n, 0n]) } };
    const r = decodeDetections(out, { classes: ['a', 'b'], threshold: 0.3, output: { format: 'boxes', boxes: 'b', scores: 's', labels: 'l', normalized: true }, input: { size: [100, 100] } }, { fx: 1, fy: 1, w: 100, h: 100 });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ cls: 'b', score: 0.6 });
    expect(r[0].box.map((v) => Math.round(v))).toEqual([10, 10, 20, 20]);
  });

  it('turns logits into a class raster with counts, and a mask with a threshold', () => {
    // 2 classes on a 2 × 2 output covering a 4 × 4 tile.
    const d = new Float32Array([1, 0, 0, 1, 0, 1, 1, 0]);
    const r = classify({ o: { dims: [1, 2, 2, 2], data: d } }, { output: { format: 'logits' } }, { W: 4, H: 4, rw: 4, rh: 4, w: 4, h: 4 });
    expect(Array.from(r.classes)).toEqual([0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0]);
    expect(r.counts).toEqual([8, 8]);
    const m = classify({ o: { dims: [1, 1, 1, 2], data: new Float32Array([-2, 3]) } }, { threshold: 0.5, output: { format: 'mask', sigmoid: true } }, { W: 2, H: 1, rw: 2, rh: 1, w: 2, h: 1 });
    expect(Array.from(m.classes)).toEqual([0, 1]);
  });
});
