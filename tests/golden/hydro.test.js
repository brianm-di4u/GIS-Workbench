// REQ-GAP-80 (SDP-2.7 §4.2, §7.3): the shipped `hydro` bundle against WhiteboxTools 2.3.0 run
// offline on the same grid (fixtures/hydro, made by tests/tools/hydro_oracle.py from the USGS 3DEP
// 1 m DRCOG 2020 tile x48y441, averaged to 5 m, 402 × 384 posts in UTM 13N). The fill and D8 match
// exactly; flats are resolved differently (our priority-flood order, WhiteboxTools' fix_flats
// gradient), so accumulation, order, watershed and D-infinity are held to stated tolerances.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { built, blockBytes } from './wasm.js';
import { HydroBundle, decodeStreams } from '../../app/src/wasm/hydro.js';

const FX = 'fixtures/hydro';
const truth = JSON.parse(readFileSync(`${FX}/truth.json`, 'utf8'));
const raw = (n) => {
  const b = gunzipSync(readFileSync(`${FX}/${n}.gz`));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const { w, h, res } = truth;
const n = w * h;
const dem = new Float32Array(raw('dem.f32'));
const report = {};

describe.skipIf(!built)('hydro bundle against WhiteboxTools (REQ-GAP-80)', () => {
  let B;
  let plain;
  let eps;
  beforeAll(async () => {
    B = new HydroBundle(new WebAssembly.Module(blockBytes('wasm-hydro')));
    plain = await B.run(dem, w, h, { dx: res, dy: res, eps: false, want: ['filled', 'dir'] });
    const [sx, sy] = truth.snapped.px;
    const pourPost = Math.floor((truth.pour.utm[1] - truth.geotransform[3]) / truth.geotransform[5]) * w + Math.floor((truth.pour.utm[0] - truth.geotransform[0]) / res);
    eps = await B.run(dem, w, h, { dx: res, dy: res, eps: true, thresh: truth.streams.threshold_cells, pour: [pourPost], snap: Math.round(truth.pour.snap_m / res), want: ['acc', 'strahler', 'shreve', 'labels'] });
    eps.expectSnap = sy * w + sx;
  });

  it('fill (flats kept) equals FillDepressions post for post', () => {
    const r = new Uint8Array(raw('fill_raised.bin'));
    const k = r.byteLength / 8;
    const idx = new Uint32Array(r.buffer, r.byteOffset, k);
    const val = new Float32Array(r.buffer, r.byteOffset + 4 * k, k);
    const want = Float32Array.from(dem);
    for (let i = 0; i < k; i++) want[idx[i]] = val[i];
    let diff = 0;
    for (let i = 0; i < n; i++) if (plain.filled[i] !== want[i]) diff++;
    report.fill = { raisedByOracle: k, raisedByUs: plain.stats.raised, differ: diff };
    expect(diff).toBe(0);
  });

  it('D8 equals D8Pointer wherever a post has a lower neighbour (exact)', () => {
    const wb = new Uint8Array(raw('d8plain.u8'));
    const f = plain.filled;
    let compared = 0;
    let differ = 0;
    let ties = 0;
    const DX = [1, 1, 0, -1, -1, -1, 0, 1];
    const DY = [0, -1, -1, -1, 0, 1, 1, 1];
    const drop = (i, k) => (f[i] - f[i + DY[k] * w + DX[k]]) / (k % 2 ? Math.SQRT2 : 1);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!wb[i]) continue; // WhiteboxTools leaves flat posts at 0; ours take the flood parent.
        compared++;
        if (plain.dir[i] === wb[i]) continue;
        differ++;
        if (Math.abs(drop(i, plain.dir[i] - 1) - drop(i, wb[i] - 1)) < 1e-6) ties++;
      }
    report.d8 = { compared, differ, ties };
    expect(compared).toBeGreaterThan(0.9 * (w - 2) * (h - 2));
    expect(differ - ties).toBe(0);
  });

  it('accumulation, stream order, watershed and D-infinity within the stated tolerances', async () => {
    const acc = new Float32Array(raw('acc.f32'));
    const so = new Uint8Array(raw('strahler.u8'));
    const sh = new Uint32Array(raw('shreve.u32'));
    const ws = new Uint8Array(raw('watershed.u8'));
    // Accumulation on the oracle's stream posts: relative difference.
    const rel = [];
    const relOut = [];
    for (let i = 0; i < n; i++)
      if (acc[i] >= truth.streams.threshold_cells) {
        const e = Math.abs(eps.acc[i] - acc[i]) / acc[i];
        rel.push(e);
        if (plain.filled[i] === dem[i] && plain.dir[i] !== 0) relOut.push(e);
      }
    rel.sort((a, b) => a - b);
    relOut.sort((a, b) => a - b);
    // Strahler on posts both call stream.
    let both = 0;
    let same = 0;
    let oursOnly = 0;
    let theirsOnly = 0;
    for (let i = 0; i < n; i++) {
      const a = eps.strahler[i] > 0;
      const b = so[i] > 0;
      if (a && b) {
        both++;
        if (eps.strahler[i] === so[i]) same++;
      } else if (a) oursOnly++;
      else if (b) theirsOnly++;
    }
    // Watershed IoU.
    let inter = 0;
    let uni = 0;
    for (let i = 0; i < n; i++) {
      const a = eps.labels[i] === 1;
      const b = ws[i] === 1;
      if (a && b) inter++;
      if (a || b) uni++;
    }
    const dinf = await B.run(dem, w, h, { dx: res, dy: res, eps: true, dinf: true, want: ['dinfAcc'] });
    const wd = new Uint32Array(raw('dinf16.u32'));
    const drel = [];
    for (let i = 0; i < n; i++) {
      const t = wd[i] / 16;
      if (t >= 100) drel.push(Math.abs(dinf.dinfAcc[i] - t) / t);
    }
    drel.sort((a, b) => a - b);
    const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
    const links = decodeStreams(eps.streams);
    Object.assign(report, {
      acc: { streamPosts: rel.length, median: q(rel, 0.5), p90: q(rel, 0.9), within1pct: rel.filter((v) => v <= 0.01).length / rel.length, outsideFills: relOut.length, outsideWithin1pct: relOut.filter((v) => v <= 0.01).length / relOut.length, outsideP90: q(relOut, 0.9) },
      strahler: { both, same, oursOnly, theirsOnly, maxOurs: eps.strahler.reduce((a, v) => Math.max(a, v), 0), maxOracle: truth.streams.max_strahler },
      shreve: { maxOurs: eps.shreve.reduce((a, v) => Math.max(a, v), 0), maxOracle: truth.streams.max_shreve },
      watershed: { iou: inter / uni, ours: eps.areas?.[0] ?? eps.labels.reduce((a, v) => a + (v === 1), 0), oracle: truth.watershed.cells, snapped: eps.pour[0], oracleSnapped: eps.expectSnap },
      dinf: { posts: drel.length, median: q(drel, 0.5), p90: q(drel, 0.9), lost: dinf.stats.dinfLost },
      links: links.length,
    });
    console.log(JSON.stringify(report));
    // Accumulation: exact (within 0.5 %) on every oracle stream post outside the filled areas; the
    // paths across filled flats differ, so at least 90 % of all stream posts within 1 %.
    expect(report.acc.outsideFills).toBeGreaterThan(0.7 * report.acc.streamPosts);
    expect(relOut.every((v) => v <= 0.005)).toBe(true);
    expect(report.acc.within1pct).toBeGreaterThanOrEqual(0.9);
    // Strahler: the same order on 99 % of the posts both call stream, the same highest order, and
    // no more than 10 % of the oracle's stream posts placed differently (paths across flats).
    expect(same / both).toBeGreaterThanOrEqual(0.99);
    expect(report.strahler.maxOurs).toBe(truth.streams.max_strahler);
    expect(oursOnly + theirsOnly).toBeLessThanOrEqual(0.1 * truth.streams.cells);
    expect(report.shreve.maxOurs).toBe(truth.streams.max_shreve);
    // Watershed: the same snapped pour point and the same posts.
    expect(eps.pour[0]).toBe(eps.expectSnap);
    expect(report.watershed.iou).toBeGreaterThanOrEqual(0.999);
    // D-infinity: 90 % of the posts with at least 100 upslope cells within 1 %.
    expect(report.dinf.p90).toBeLessThanOrEqual(0.01);
    // Stream lines: one link per oracle link at least (two order-1 heads make an order-2 trunk).
    expect(links.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a grid above 48 million posts before allocating', async () => {
    const big = { length: 48e6 + 1 };
    await expect(B.run(big, 48e6 + 1, 1, { dx: 1, dy: 1 })).rejects.toThrow(/48 million posts/);
  });
});
