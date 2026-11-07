// REQ-LAI-04 (VLM drafts: tokenizer, the D30 measurement filter, counts), REQ-LAI-05 (change
// mask: measured on a synthetic pair with known changes, a gain/offset change and a one-pixel
// shift) and REQ-GAP-56 (the int8 → float16 model converter).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { BpeTokenizer } from '../../app/src/ai/bpe-tokenizer.js';
import { stripMeasurements, parseCount, vlmPrompt, f32ToF16, f16ToF32 } from '../../app/src/workers/ai/vlm.js';
import { changeMask, maskScores } from '../../app/src/workers/ai/change.js';
import { f16bits, convertModel, decodeModel } from '../../build/onnx-fp16.mjs';

const MD = 'D:/gwb24/data-extai/moondream2';

describe('REQ-LAI-04 Moondream2 tokenizer', () => {
  it('round-trips text through a small byte-level vocabulary', () => {
    // Bytes of "ab c" in the GPT-2 alphabet: a b Ġ(space) c; one merge "a b".
    const vocab = { a: 0, b: 1, 'Ġ': 2, c: 3, ab: 4, 'Ġc': 5, '<|endoftext|>': 6 };
    const tk = new BpeTokenizer(vocab, '#version: 0.2\na b\nĠ c\n', { '<|endoftext|>': 6, '<image>': -200 });
    const ids = tk.encode('<image>ab c<|endoftext|>');
    expect(ids).toEqual([-200, 4, 5, 6]);
    expect(tk.decode([4, 5, 6], { special: new Set([6]) })).toBe('ab c');
  });

  it.skipIf(!existsSync(`${MD}/vocab.json`))('encodes the Moondream2 prompt like the reference tokenizer.json', () => {
    const tk = new BpeTokenizer(JSON.parse(readFileSync(`${MD}/vocab.json`, 'utf8')), readFileSync(`${MD}/merges.txt`, 'utf8'), { ...JSON.parse(readFileSync(`${MD}/added_tokens.json`, 'utf8')), '<|endoftext|>': 50256, '<image>': -200 });
    const ids = tk.encode(vlmPrompt('Describe this image.'));
    // <image>, "\n\n", "Question", ":", " Describe", " this", " image", ".", "\n\n", "Answer", ":"
    expect(ids[0]).toBe(-200);
    expect(ids).toEqual([-200, 198, 198, 24361, 25, 39373, 4892, 428, 2939, 13, 198, 198, 33706, 25]); // ' Describe' is ' Desc' + 'ribe' in this vocabulary
    expect(tk.decode(ids.slice(1))).toBe('\n\nQuestion: Describe this image.\n\nAnswer:');
    const tj = JSON.parse(readFileSync(`${MD}/tokenizer.json`, 'utf8'));
    for (const id of ids.slice(1)) expect(Object.values(tj.model.vocab)).toContain(id);
    const s = 'Two white trucks are parked near a hangar; one has its door open.';
    expect(tk.decode(tk.encode(s))).toBe(s);
    expect(tk.decode(tk.encode('  tabs\t\tand   spaces'))).toBe('  tabs\t\tand   spaces');
  });
});

describe('REQ-LAI-04 D30: drafts never carry measurements', () => {
  it('takes out lengths, areas, heights, speeds and coordinates; keeps counts', () => {
    const r = stripMeasurements('A runway about 2,500 m long and 45 m wide, a 30-ft tower, 3 aircraft, a 1200 square metres apron, a ship at 12 knots, at 31.5000, 34.4500 and 36SXA1234567890; 2 hangars 60 x 40 m.');
    expect(r.text).not.toMatch(/\d[\d,.]*\s?(m|ft|knots|square metres)\b/);
    expect(r.text).toMatch(/3 aircraft/);
    expect(r.text).toMatch(/2 hangars/);
    expect(r.removed).toEqual(expect.arrayContaining(['31.5000, 34.4500', '36SXA1234567890', 'about 2,500 m long', '45 m wide', '30-ft', '1200 square metres', '12 knots', '60 x 40 m']));
    expect(stripMeasurements('Three boats are moored.').removed).toEqual([]);
  });
  it('reads a count from short answers', () => {
    expect(parseCount('3')).toBe(3);
    expect(parseCount('There are 12 cars.')).toBe(12);
    expect(parseCount('two')).toBe(2);
    expect(parseCount('None.')).toBe(0);
    expect(parseCount('I cannot tell.')).toBe(null);
  });
  it('converts float16 both ways', () => {
    for (const v of [0, 1, -2.5, 65504, 1e-5, 0.1]) expect(Math.abs(f16ToF32(f32ToF16(v)) - v)).toBeLessThan(Math.abs(v) * 1e-3 + 1e-7);
    expect(f16bits(1)).toBe(0x3c00);
    expect(f16bits(-2)).toBe(0xc000);
    expect(f16bits(65520)).toBe(0x7c00); // overflow → inf
    expect(f16bits(2 ** -24)).toBe(1); // smallest subnormal
    expect(f32ToF16(1)).toBe(0x3c00);
  });
});

/** A deterministic textured scene, w × h, 8-bit. */
function scene(w, h, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const v = new Float32Array(w * h);
  const waves = Array.from({ length: 6 }, () => [rnd() * 0.2, rnd() * 0.2, rnd() * 6, 10 + rnd() * 20]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[y * w + x] = 110 + waves.reduce((a, [fx, fy, p, amp]) => a + amp * Math.sin(fx * x + fy * y + p), 0);
  return { v, rnd };
}

describe('REQ-LAI-05 change mask (synthetic pair, measured)', () => {
  it('finds pasted changes after a gain/offset change and a one-pixel shift', () => {
    const w = 400;
    const h = 300;
    const { v, rnd } = scene(w, h);
    const a = new Uint8Array(w * h);
    const b = new Uint8Array(w * h);
    const truth = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = Math.max(0, Math.min(255, Math.round(v[i] + (rnd() - 0.5) * 6)));
    // b: the same scene shifted by one pixel, darker and with more contrast, plus noise.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = Math.max(0, Math.min(255, Math.round(1.15 * v[y * w + Math.max(0, x - 1)] - 30 + (rnd() - 0.5) * 6)));
    // Three changes: a bright roof, a dark patch, a textured block.
    const rects = [[50, 40, 90, 80, 250], [200, 150, 260, 190, 10], [300, 60, 360, 140, -1]];
    for (const [x0, y0, x1, y1, val] of rects)
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          b[y * w + x] = val >= 0 ? val : (x + y) % 20 < 10 ? 240 : 20;
          truth[y * w + x] = 1;
        }
    const r = changeMask(a, b, w, h, { threshold: 2.5, minArea: 64 });
    const sc = maskScores(r.mask, truth);
    // Measured on this pair (docs/validation/2.4/extai.md): IoU 0.883, precision 0.934, recall 0.942.
    expect(sc.iou).toBeGreaterThan(0.85);
    expect(sc.precision).toBeGreaterThan(0.9);
    expect(sc.recall).toBeGreaterThan(0.9);
    // The three changes, plus at most two small spill regions.
    expect(r.regions.length).toBeGreaterThanOrEqual(3);
    expect(r.regions.length).toBeLessThanOrEqual(5);
    expect(r.gain).toBeGreaterThan(0.8);
    expect(r.gain).toBeLessThan(0.95); // b ≈ 1.15 a − 30 → a ≈ 0.87 b + 26
    globalThis.__changeScores = { ...sc, regions: r.regions.length, changedFraction: r.changedFraction };
  });

  it('marks nothing when the only differences are radiometry, noise and a one-pixel shift', () => {
    const w = 300;
    const h = 200;
    const { v, rnd } = scene(w, h, 7);
    const a = new Uint8Array(w * h);
    const b = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = Math.max(0, Math.min(255, Math.round(v[i] + (rnd() - 0.5) * 6)));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = Math.max(0, Math.min(255, Math.round(0.9 * v[Math.max(0, y - 1) * w + x] + 15 + (rnd() - 0.5) * 6)));
    const r = changeMask(a, b, w, h, { threshold: 2.5, minArea: 64 });
    expect(r.regions).toHaveLength(0);
    expect(r.changedFraction).toBeLessThan(0.002);
  });

  it('refuses windows that do not overlap', () => {
    expect(() => changeMask(new Uint8Array(100), new Uint8Array(100), 10, 10, { valid: new Uint8Array(100) })).toThrow(/do not overlap/);
  });
});

const ENC = '.cache/packs-src/sam2_vision_encoder_int8.onnx';
describe('REQ-GAP-56 int8 → float16 conversion', () => {
  it.skipIf(!existsSync(ENC))('dequantises the SAM 2.1 encoder exactly and converts it to float16 with float32 inputs and outputs', () => {
    const r = convertModel(readFileSync(ENC), readFileSync(`${ENC}_data`));
    expect(r.replaced).toBe(58);
    const m = decodeModel(r.bytes);
    const ops = new Set(m.graph.node.map((n) => n.opType));
    for (const q of ['DynamicQuantizeLinear', 'MatMulInteger', 'ConvInteger']) expect(ops.has(q)).toBe(false);
    expect(m.graph.input.map((i) => i.type.tensorType.elemType)).toEqual([1]);
    expect(m.graph.output.every((o) => o.type.tensorType.elemType === 1)).toBe(true);
    const types = new Set(m.graph.initializer.map((t) => t.dataType));
    expect(types.has(10)).toBe(true);
    expect([...types].every((x) => [7, 10, 1].includes(x))).toBe(true);
    // Deterministic: the same input gives the same bytes.
    const again = convertModel(readFileSync(ENC), readFileSync(`${ENC}_data`));
    expect(Buffer.compare(again.bytes, r.bytes)).toBe(0);
  }, 120000);
});
