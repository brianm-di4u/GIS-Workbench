// SCN-11 AT-11.3: on the FX-06 pair, default settings find ≥ 10 of the 12 changes with ≤ 5
// false polygons; the radiometric fit recovers the inserted gain and offset.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fromArrayBuffer } from 'geotiff';
import { detectChanges, radiometricFit } from '../../app/src/analysis/change.js';

const DIR = 'fixtures/fx06';
const have = existsSync(`${DIR}/fx06_truth.json`);

async function read(f) {
  const b = readFileSync(`${DIR}/${f}`);
  const t = await fromArrayBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const im = await t.getImage();
  const [r] = await im.readRasters();
  return { w: im.getWidth(), h: im.getHeight(), v: Float32Array.from(r) };
}

describe.skipIf(!have)('change detection on FX-06', () => {
  it('AT-11.3 finds ≥ 10 of 12 changes with ≤ 5 false polygons; recovers gain and offset', async () => {
    const truth = JSON.parse(readFileSync(`${DIR}/fx06_truth.json`, 'utf8'));
    const a = await read('fx06_date1.tif');
    const b = await read('fx06_date2.tif');
    const r = detectChanges(a.v, b.v, a.w, a.h);
    expect(Math.abs(r.gain - truth.radiometric.gain)).toBeLessThan(0.02);
    expect(Math.abs(r.offset - truth.radiometric.offset)).toBeLessThan(3);
    const hit = (c, t) => !(c.x1 < t.x || t.x + t.w < c.x0 || c.y1 < t.y || t.y + t.h < c.y0);
    const found = truth.changes.filter((t) => r.candidates.some((c) => hit(c, t)));
    const falses = r.candidates.filter((c) => !truth.changes.some((t) => hit(c, t)));
    expect(found.length, `found ${found.map((t) => t.id)}`).toBeGreaterThanOrEqual(10);
    expect(falses.length).toBeLessThanOrEqual(5);
  });
  it('the robust fit ignores outliers', () => {
    const a = Float32Array.from({ length: 10000 }, (_, i) => i % 200);
    const b = a.map((v, i) => (i % 97 === 0 ? 255 : 2 * v + 5));
    const f = radiometricFit(a, b, null, 1);
    expect(f.gain).toBeCloseTo(2, 2);
    expect(f.offset).toBeCloseTo(5, 0);
  });
});
