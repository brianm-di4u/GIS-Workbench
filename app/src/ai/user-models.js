// User-supplied ONNX models (REQ-GAP-57): detection, segmentation and pixel classification models
// the analyst adds, under the same rules as the model packs (REQ-ARC-14, REQ-LAI-08):
//   - a gw-model/1 descriptor declares the task, the input spec, the output format, the classes,
//     the SPDX licences of code and weights and the SHA-256 of the .onnx file;
//   - the file's SHA-256 must equal the declared one, here and on every later load;
//   - the licences must be permissive (MIT, Apache-2.0, BSD-2/3-Clause, ISC) and the licence text
//     may not name non-commercial, research-only or GPL terms; models known to carry such licences
//     (YOLO-World, SuperPoint, Qwen2.5-VL-3B) are refused by name;
//   - the graph may use only the standard ONNX operator domains (no custom-op libraries), and
//     no external data (the file is the whole model);
//   - the descriptor is data: unknown keys are refused and no field is ever run, fetched or shown
//     as HTML. The model runs in the AI worker's onnxruntime, which has no network (CSP).
// Errors are English with codes (E_MODEL_*); shown with msgOf.

import { gwError } from '../i18n/index.js';

export const MODEL_FORMAT = 'gw-model/1';
/** The same list as build/gates.mjs MODEL_LICENCES (a unit test keeps them equal). */
export const MODEL_LICENCES = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);
const BAD_TEXT = /\bnon-commercial\b|\bnoncommercial\b|\bCC[- ]BY[- ]NC\b|\bA?GPL\b|\bresearch[- ]only\b|Research Licen[cs]e|\bOpenRAIL\b|\bLlama\b.*licen[cs]e/i;
/** Models whose licences the gate rejects (REQ-LAI-08 review): YOLO-World (GPL-3.0), SuperPoint (non-commercial), Qwen2.5-VL-3B (Qwen Research). */
const DENIED = /yolo[\s_-]*world|super[\s_-]*point|qwen\s*2(\.5)?[\s_-]*vl[\s_-]*3b/i;
const TASKS = new Set(['detection', 'segmentation', 'classification']);
const OUT = { detection: new Set(['yolov8', 'boxes']), segmentation: new Set(['logits', 'mask']), classification: new Set(['logits']) };
const ALLOWED_DOMAINS = new Set(['', 'ai.onnx', 'ai.onnx.ml', 'com.microsoft']);
export const MAX_MODEL_BYTES = 1.5e9;

const KEYS = {
  top: new Set(['format', 'id', 'name', 'task', 'version', 'description', 'licence', 'sha256', 'size', 'input', 'output', 'classes', 'colors', 'threshold', 'gsd', 'source']),
  licence: new Set(['spdx', 'text', 'url']),
  input: new Set(['name', 'size', 'channels', 'layout', 'range', 'mean', 'std', 'resize', 'padValue', 'bands']),
  output: new Set(['format', 'name', 'boxes', 'scores', 'labels', 'normalized', 'iou', 'sigmoid']),
};

const bad = (msg, params, code = 'E_MODEL_DESCRIPTOR') => gwError(msg, params, code);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const strOk = (v, n = 200) => typeof v === 'string' && v.length <= n && !/[<>]/.test(v);

function onlyKeys(o, set, where) {
  for (const k of Object.keys(o)) if (!set.has(k)) throw bad('{where}: unknown field {field}', { where, field: k });
}

/** The licence check alone: errors (English) for a {spdx, text} declaration (empty when it passes). */
export function licenceIssues(lic, name = '') {
  const out = [];
  if (!lic || !Array.isArray(lic.spdx) || !lic.spdx.length) out.push('the descriptor declares no SPDX licence');
  for (const l of lic?.spdx ?? []) if (!MODEL_LICENCES.has(l)) out.push(`${l} is not a permissive licence (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause or ISC)`);
  const m = BAD_TEXT.exec(String(lic?.text ?? ''));
  if (m) out.push(`the licence text mentions "${m[0]}"`);
  const d = DENIED.exec(String(name));
  if (d) out.push(`${d[0]} is not permissively licensed`);
  return out;
}

/** Check a descriptor → a normalised copy, or throw (codes E_MODEL_DESCRIPTOR, E_MODEL_LICENCE). */
export function validateDescriptor(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw bad('a model descriptor is a JSON object', {});
  onlyKeys(d, KEYS.top, 'descriptor');
  if (d.format !== MODEL_FORMAT) throw bad('not a model descriptor (format "{format}", expected "{expected}")', { format: String(d.format ?? '?'), expected: MODEL_FORMAT });
  if (typeof d.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(d.id)) throw bad('the model id must be 1–64 lower-case letters, digits or . _ -', {});
  if (!strOk(d.name, 120) || !d.name.trim()) throw bad('the model has no name', {});
  if (!TASKS.has(d.task)) throw bad('the task must be detection, segmentation or classification', {});
  if (typeof d.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.sha256)) throw bad('the descriptor needs the SHA-256 of the .onnx file (64 hex digits)', {});
  if (!d.licence || typeof d.licence !== 'object') throw bad('the descriptor declares no licence', {}, 'E_MODEL_LICENCE');
  onlyKeys(d.licence, KEYS.licence, 'licence');
  const li = licenceIssues(d.licence, `${d.id} ${d.name} ${d.description ?? ''} ${d.source ?? ''}`);
  if (li.length) throw bad('the model licence is refused: {why}', { why: li.join('; ') }, 'E_MODEL_LICENCE');
  const inp = d.input;
  if (!inp || typeof inp !== 'object') throw bad('the descriptor has no input spec', {});
  onlyKeys(inp, KEYS.input, 'input');
  if (!Array.isArray(inp.size) || inp.size.length !== 2 || !inp.size.every((v) => Number.isInteger(v) && v >= 16 && v <= 4096)) throw bad('input.size must be [height, width], 16–4096 pixels', {});
  const ch = inp.channels ?? 3;
  if (![1, 3].includes(ch)) throw bad('input.channels must be 1 or 3', {});
  if (inp.layout !== undefined && !['NCHW', 'NHWC'].includes(inp.layout)) throw bad('input.layout must be NCHW or NHWC', {});
  if (inp.range !== undefined && !(Array.isArray(inp.range) && inp.range.length === 2 && inp.range.every(isNum) && inp.range[1] > inp.range[0])) throw bad('input.range must be [min, max]', {});
  for (const k of ['mean', 'std']) if (inp[k] !== undefined && !(Array.isArray(inp[k]) && inp[k].length === 3 && inp[k].every(isNum) && (k === 'mean' || inp[k].every((v) => v > 0)))) throw bad('input.{key} must be three numbers', { key: k });
  if (inp.resize !== undefined && !['stretch', 'pad'].includes(inp.resize)) throw bad('input.resize must be stretch or pad', {});
  if (inp.name !== undefined && !strOk(inp.name, 128)) throw bad('input.name is not a tensor name', {});
  if (inp.bands !== undefined && !(Array.isArray(inp.bands) && inp.bands.length === ch && inp.bands.every((b) => Number.isInteger(b) && b >= 0 && b < 64))) throw bad('input.bands must list one band index per channel', {});
  const out = d.output;
  if (!out || typeof out !== 'object') throw bad('the descriptor has no output spec', {});
  onlyKeys(out, KEYS.output, 'output');
  if (!OUT[d.task].has(out.format)) throw bad('output.format {format} does not fit a {task} model', { format: String(out.format), task: d.task });
  for (const k of ['name', 'boxes', 'scores', 'labels']) if (out[k] !== undefined && !strOk(out[k], 128)) throw bad('output.{key} is not a tensor name', { key: k });
  if (out.format === 'boxes' && (!out.boxes || !out.scores)) throw bad('a boxes output names its boxes and scores tensors', {});
  if (!Array.isArray(d.classes) || !d.classes.length || d.classes.length > 1000 || !d.classes.every((c) => strOk(c, 80))) throw bad('classes must list 1–1000 class names', {});
  if (d.colors !== undefined && !(Array.isArray(d.colors) && d.colors.length === d.classes.length && d.colors.every((c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)))) throw bad('colors must give one [r, g, b] per class', {});
  if (d.threshold !== undefined && !(isNum(d.threshold) && d.threshold >= 0 && d.threshold <= 1)) throw bad('threshold must be between 0 and 1', {});
  if (d.size !== undefined && !(Number.isInteger(d.size) && d.size > 0)) throw bad('size must be the file size in bytes', {});
  for (const k of ['version', 'description', 'source']) if (d[k] !== undefined && !strOk(String(d[k]), 2000)) throw bad('{key} is too long or has markup', { key: k });
  if (d.gsd !== undefined && !(isNum(d.gsd) && d.gsd > 0)) throw bad('gsd must be metres per pixel', {});
  return JSON.parse(JSON.stringify({ ...d, input: { channels: ch, layout: 'NCHW', range: [0, 1], resize: 'stretch', ...inp }, threshold: d.threshold ?? (d.task === 'detection' ? 0.25 : 0.5) }));
}

// ---- the .onnx file ----

function varint(b, p) {
  let v = 0;
  let s = 0;
  let x;
  do {
    if (p >= b.length) throw bad('the .onnx file is cut short', {}, 'E_MODEL_FILE');
    x = b[p++];
    v += (x & 0x7f) * 2 ** s;
    s += 7;
  } while (x & 0x80 && s < 64);
  return [v, p];
}
/** Walk the length-delimited fields of a message: fn(field, wire, start, end) for each. */
function fields(b, start, end, fn) {
  let p = start;
  while (p < end) {
    let key;
    [key, p] = varint(b, p);
    const f = Math.floor(key / 8);
    const w = key & 7;
    if (w === 0) [, p] = varint(b, p);
    else if (w === 1) p += 8;
    else if (w === 5) p += 4;
    else if (w === 2) {
      let len;
      [len, p] = varint(b, p);
      if (p + len > end) throw bad('the .onnx file is cut short', {}, 'E_MODEL_FILE');
      fn(f, w, p, p + len);
      p += len;
    } else throw bad('not an ONNX model (bad protobuf)', {}, 'E_MODEL_FILE');
  }
}
const text = (b, s, e) => new TextDecoder().decode(b.subarray(s, e));

/**
 * What the gate needs from an ONNX ModelProto without a protobuf library: the operator-set
 * domains, the node domains, whether any initializer is external data, and the graph's input and
 * output names. Throws when the bytes are not an ONNX model.
 */
export function inspectOnnx(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 16 || b[0] !== 0x08) throw bad('not an ONNX model (it does not start with an IR version)', {}, 'E_MODEL_FILE');
  const opsets = [];
  const nodeDomains = new Set();
  const inputs = [];
  const outputs = [];
  const inits = new Set();
  let external = 0;
  let graph = false;
  fields(b, 0, b.length, (f, w, s, e) => {
    if (f === 8) {
      let dom = '';
      fields(b, s, e, (g, ww, s2, e2) => {
        if (g === 1) dom = text(b, s2, e2);
      });
      opsets.push(dom);
    }
    if (f === 7) {
      graph = true;
      fields(b, s, e, (g, ww, s2, e2) => {
        if (g === 1) {
          // NodeProto: domain = 7
          fields(b, s2, e2, (h, www, s3, e3) => {
            if (h === 7) nodeDomains.add(text(b, s3, e3));
          });
        } else if (g === 5) {
          // TensorProto: name = 8, data_location = 14 (varint; EXTERNAL = 1), external_data = 13
          let name = '';
          fields(b, s2, e2, (h, www, s3, e3) => {
            if (h === 8) name = text(b, s3, e3);
            if (h === 13) external++;
          });
          inits.add(name);
        } else if (g === 11 || g === 12) {
          let name = '';
          fields(b, s2, e2, (h, www, s3, e3) => {
            if (h === 1) name = text(b, s3, e3);
          });
          (g === 11 ? inputs : outputs).push(name);
        }
      });
    }
  });
  if (!graph) throw bad('not an ONNX model (no graph)', {}, 'E_MODEL_FILE');
  return { opsets, nodeDomains: [...nodeDomains], external, inputs: inputs.filter((n) => !inits.has(n)), outputs };
}

export async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * The full gate: descriptor + file bytes → {descriptor, info}. Throws (E_MODEL_HASH, E_MODEL_FILE,
 * E_MODEL_OPS, E_MODEL_EXTERNAL, E_MODEL_IO, E_MODEL_SIZE and the descriptor codes).
 */
export async function checkUserModel(descriptor, bytes) {
  const d = validateDescriptor(descriptor);
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length > MAX_MODEL_BYTES) throw bad('the model is larger than {gb} GB', { gb: String(MAX_MODEL_BYTES / 1e9) }, 'E_MODEL_SIZE');
  if (d.size !== undefined && d.size !== b.length) throw bad('the file is {n} bytes, the descriptor says {m}', { n: String(b.length), m: String(d.size) }, 'E_MODEL_HASH');
  const h = await sha256Hex(b);
  if (h !== d.sha256) throw bad('the file does not match the SHA-256 in its descriptor (file {got}, declared {want})', { got: h.slice(0, 16), want: d.sha256.slice(0, 16) }, 'E_MODEL_HASH');
  const info = inspectOnnx(b);
  const doms = [...new Set([...info.opsets, ...info.nodeDomains])].filter((x) => !ALLOWED_DOMAINS.has(x));
  if (doms.length) throw bad('the model uses custom operator domains ({domains}); only standard ONNX operators run here', { domains: doms.join(', ') }, 'E_MODEL_OPS');
  if (info.external) throw bad('the model keeps weights in external data files; give a single .onnx file', {}, 'E_MODEL_EXTERNAL');
  if (!info.inputs.length) throw bad('the model has no input', {}, 'E_MODEL_IO');
  if (d.input.name && !info.inputs.includes(d.input.name)) throw bad('the model has no input {name} (it has {inputs})', { name: d.input.name, inputs: info.inputs.join(', ') }, 'E_MODEL_IO');
  for (const k of ['name', 'boxes', 'scores', 'labels']) if (d.output[k] && !info.outputs.includes(d.output[k])) throw bad('the model has no output {name} (it has {outputs})', { name: d.output[k], outputs: info.outputs.join(', ') }, 'E_MODEL_IO');
  return { descriptor: d, info, sha256: h };
}

/** The descriptor of the shipped land-cover pack model (ai-landcover), in the same form. */
export const LANDCOVER = {
  format: MODEL_FORMAT,
  id: 'landcover-oem',
  name: 'Land cover (OpenEarthMap SparseMask)', // i18n-ignore: model product name
  task: 'classification',
  licence: { spdx: ['MIT'], text: 'SparseMask OpenEarthMap model, MIT; trained on OpenEarthMap (CC-BY-4.0)' },
  input: { size: [1024, 1024], channels: 3, layout: 'NCHW', range: [0, 1], mean: [0.4325, 0.4483, 0.3879], std: [0.0195, 0.0169, 0.0179], resize: 'stretch' },
  output: { format: 'logits' },
  classes: ['bareland', 'rangeland', 'developed space', 'road', 'tree', 'water', 'agriculture land', 'buildings'],
  colors: [[128, 0, 0], [0, 255, 0], [192, 192, 192], [255, 255, 255], [49, 139, 87], [0, 0, 255], [127, 255, 0], [255, 0, 0]],
  gsd: 0.5,
};
