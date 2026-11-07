// REQ-LAI-02 REQ-LAI-03 REQ-LAI-01 REQ-LAI-09: the orthogonal regularizer, the CLIP tokenizer, box NMS and
// the AI hardware tiers.
import { describe, it, expect } from 'vitest';
import { regularize } from '../../app/src/vector/regularize.js';
import { ClipTokenizer } from '../../app/src/ai/clip-tokenizer.js';
import { nms, boxIou, toPlanes } from '../../app/src/workers/ai/image.js';
import { probeAi } from '../../app/src/ai/hw.js';

const rot = (p, a) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];

describe('orthogonal regularizer', () => {
  it('squares a noisy, rotated L-shaped outline', () => {
    const L = [[0, 0], [60, 0], [60, 20], [25, 20], [25, 50], [0, 50]];
    const a = (30 * Math.PI) / 180;
    // Densify the edges and add ±0.8 px noise (deterministic).
    const noisy = [];
    L.forEach((p, i) => {
      const q = L[(i + 1) % L.length];
      for (let t = 0; t < 1; t += 0.1) {
        const k = noisy.length;
        noisy.push(rot([p[0] + (q[0] - p[0]) * t + 0.8 * Math.sin(k * 1.7), p[1] + (q[1] - p[1]) * t + 0.8 * Math.cos(k * 2.3)], a));
      }
    });
    const r = regularize(noisy, { minLen: 4 });
    expect(r).toHaveLength(6);
    for (let i = 0; i < r.length; i++) {
      const p = r[i];
      const q = r[(i + 1) % r.length];
      const s = r[(i + 2) % r.length];
      const d1 = [q[0] - p[0], q[1] - p[1]];
      const d2 = [s[0] - q[0], s[1] - q[1]];
      expect(Math.abs(d1[0] * d2[0] + d1[1] * d2[1]) / (Math.hypot(...d1) * Math.hypot(...d2))).toBeLessThan(1e-9);
    }
    // Every true corner is within 1.5 px of a squared corner.
    for (const c of L.map((p) => rot(p, a))) expect(Math.min(...r.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])))).toBeLessThan(1.5);
  });
  it('leaves a triangle alone', () => {
    expect(regularize([[0, 0], [10, 0], [5, 8]])).toHaveLength(3);
  });
});

describe('CLIP tokenizer', () => {
  const vocab = { '<|startoftext|>': 49406, '<|endoftext|>': 49407, 'a</w>': 320, 'c': 66, 'a': 64, 'r': 81, 'ca': 600, 'car</w>': 1615, 'r</w>': 337, '!</w>': 0 };
  const t = new ClipTokenizer(vocab, '#version: 0.2\nc a\nca r</w>\n');
  it('lower-cases, merges by rank and wraps in start/end tokens', () => {
    expect(t.encode('  A   CAR ')).toEqual([49406, 320, 1615, 49407]);
  });
  it('pads a batch with the pad id and masks the padding', () => {
    const b = t.batch(['a car', 'car'], 6, 0);
    expect(Array.from(b.ids, Number)).toEqual([49406, 320, 1615, 49407, 0, 0, 49406, 1615, 49407, 0, 0, 0]);
    expect(Array.from(b.mask, Number)).toEqual([1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0]);
  });
});

describe('detection helpers', () => {
  it('suppresses overlapping boxes of one class only', () => {
    const k = nms([
      { q: 0, score: 0.9, box: [0, 0, 10, 10] },
      { q: 0, score: 0.8, box: [1, 1, 11, 11] },
      { q: 1, score: 0.7, box: [1, 1, 11, 11] },
      { q: 0, score: 0.6, box: [30, 30, 40, 40] },
    ]);
    expect(k.map((x) => x.score)).toEqual([0.9, 0.7, 0.6]);
    expect(boxIou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(1 / 3, 6);
  });
  it('pads and normalises a resized image', () => {
    const rgb = new Uint8Array(2 * 1 * 3).fill(255);
    const px = toPlanes(rgb, 2, 1, { W: 2, H: 2, rw: 2, rh: 1, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], pad: 0.5 });
    expect(Array.from(px.subarray(0, 4))).toEqual([1, 1, 0, 0]);
  });
});

describe('AI hardware tiers', () => {
  it('is CPU-only without WebGPU, Tier 1 with f16, Tier 2 with memory', async () => {
    expect((await probeAi({})).tier).toBe(0);
    const gpu = (f16, maxBufferSize) => ({ gpu: { requestAdapter: async () => ({ features: new Set(f16 ? ['shader-f16'] : []), limits: { maxBufferSize }, info: { vendor: 'test' } }) } });
    expect((await probeAi(gpu(false, 2 ** 30))).tier).toBe(0);
    expect((await probeAi(gpu(true, 2 ** 30))).tier).toBe(1);
    expect((await probeAi({ ...gpu(true, 2 ** 32), deviceMemory: 8 })).tier).toBe(2);
  });
});

describe('copilot routing', async () => {
  const { parseIntent } = await import('../../app/src/ai/intent.js');
  it('routes plain requests to local tools', () => {
    expect(parseIntent('Detect aircraft and vehicles in view')).toEqual({ intent: 'find', objects: ['aircraft', 'vehicles'], count: false });
    expect(parseIntent('count the cars, trucks')).toEqual({ intent: 'find', objects: ['cars', 'trucks'], count: true });
    expect(parseIntent('where is an unpaved runway?')).toEqual({ intent: 'search', text: 'unpaved runway' });
    expect(parseIntent('search for flooded fields in the scene')).toEqual({ intent: 'search', text: 'flooded fields' });
    expect(parseIntent('auto contrast')).toEqual({ intent: 'contrast' });
    expect(parseIntent('co-register to the reference')).toEqual({ intent: 'align' });
    expect(parseIntent('segment the building and square it')).toEqual({ intent: 'segment', square: true });
    expect(parseIntent('go to 38SMB4484')).toEqual({ intent: 'goto', text: '38SMB4484' });
    expect(parseIntent('what sensor took this image?')).toBe(null);
  });
});

describe('model licence gate (REQ-LAI-08)', async () => {
  const { modelLicenceGate } = await import('../../build/gates.mjs');
  it('passes permissive packs and refuses non-commercial or undeclared ones', () => {
    expect(modelLicenceGate([{ pack: 'ai-sam2', spdx: ['Apache-2.0'], licence: 'Apache-2.0.' }])).toEqual([]);
    expect(modelLicenceGate([{ pack: 'x', spdx: [], licence: '' }])[0]).toMatch(/declares no licence/);
    expect(modelLicenceGate([{ pack: 'x', spdx: ['GPL-3.0'], licence: '' }])[0]).toMatch(/not a permissive/);
    expect(modelLicenceGate([{ pack: 'x', spdx: ['MIT'], licence: 'Weights: CC BY-NC 4.0' }])[0]).toMatch(/CC BY-NC/);
  });
});
