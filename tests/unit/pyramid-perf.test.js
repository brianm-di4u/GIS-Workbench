// perf 2.1: the faster pyramid kernels (2×2 average, gutter gather) and the SICD amplitude must
// give exactly the values of the code they replaced. The reference implementations below are the
// 2.1 base versions, kept here verbatim in substance (per-sample accumulation in doubles from 0,
// a nodata closure per sample, Math.hypot).
import { describe, it, expect } from 'vitest';
import { Pyramid, LRU, TILE, GUTTER, ctorFor } from '../../app/src/workers/decode/pyramid.js';
import { magnitude } from '../../app/src/workers/decode/sicd.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** A synthetic source of the given type; nodata pixels sprinkled in (value, or NaN for floats). */
function source({ width, height, bands, type, nodata = null, pickBands, seed = 1 }) {
  const C = ctorFor(type);
  const r = rng(seed);
  const planes = Array.from({ length: bands }, () => {
    const p = new C(width * height);
    for (let i = 0; i < p.length; i++) {
      const u = r();
      if (nodata !== null && u < 0.07) p[i] = nodata;
      else if (type === 'f32') p[i] = (r() - 0.3) * (u < 0.5 ? 1e-3 : 1e4) * (u < 0.01 ? -0 : 1);
      else if (type === 'i16') p[i] = Math.floor((r() - 0.5) * 65535);
      else p[i] = Math.floor(r() * (type === 'u8' ? 256 : 65536));
    }
    return p;
  });
  return {
    width,
    height,
    bands,
    sampleType: type,
    nodata,
    pickBands,
    async readWindow(x0, y0, w, h, bs) {
      return bs.map((b) => {
        const o = new C(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = planes[b][(y0 + y) * width + x0 + x];
        return o;
      });
    },
  };
}

/** The 2.1 base composition of level L from its children (reference). */
async function refCore(pyr, L, tx, ty, bands) {
  if (L === 0) return Promise.all(bands.map((b) => pyr.core(0, tx, ty, b)));
  const src = pyr.src;
  const { w: lw, h: lh } = pyr.dims(L);
  const w = Math.min(TILE, lw - tx * TILE);
  const h = Math.min(TILE, lh - ty * TILE);
  const C = ctorFor(src.sampleType);
  const nd = src.nodata;
  const isNd = nd === null || nd === undefined ? () => false : Number.isNaN(nd) ? (v) => Number.isNaN(v) : (v) => v === nd;
  const { nx, ny } = pyr.tilesAt(L - 1);
  const fill = nd === null || nd === undefined ? 0 : nd;
  const round = C === Float32Array ? (v) => v : (v) => Math.round(v);
  const sums = bands.map(() => new Float64Array(w * h));
  const cnts = bands.map(() => new Uint16Array(w * h));
  for (let cy = 0; cy < 2; cy++)
    for (let cx = 0; cx < 2; cx++) {
      if (!(2 * tx + cx < nx && 2 * ty + cy < ny)) continue;
      const group = await refCore(pyr, L - 1, 2 * tx + cx, 2 * ty + cy, bands);
      for (let q = 0; q < bands.length; q++) {
        const c = group[q];
        const pick = !!src.pickBands?.includes(bands[q]);
        for (let y = 0; y < c.h; y++) {
          const yy = cy * (TILE / 2) + (y >> 1);
          if (yy >= h) continue;
          for (let x = 0; x < c.w; x++) {
            const xx = cx * (TILE / 2) + (x >> 1);
            if (xx >= w) continue;
            if (pick && ((x | y) & 1)) continue;
            const v = c.data[y * c.w + x];
            if (isNd(v)) continue;
            sums[q][yy * w + xx] += v;
            cnts[q][yy * w + xx]++;
          }
        }
      }
    }
  return bands.map((_, q) => {
    const out = new C(w * h);
    for (let i = 0; i < out.length; i++) out[i] = cnts[q][i] ? round(sums[q][i] / cnts[q][i]) : fill;
    return { w, h, data: out };
  });
}

const same = (a, b) => {
  expect(a.length).toBe(b.length);
  const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  let bad = -1;
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) {
    bad = i;
    break;
  }
  expect(bad, bad < 0 ? '' : `first difference at element ${Math.floor(bad / a.BYTES_PER_ELEMENT)}: ${a[Math.floor(bad / a.BYTES_PER_ELEMENT)]} vs ${b[Math.floor(bad / a.BYTES_PER_ELEMENT)]}`).toBe(-1);
};

describe('pyramid kernels keep their values (perf 2.1)', () => {
  const cases = [
    { type: 'u8', nodata: null },
    { type: 'u8', nodata: 0 },
    { type: 'u16', nodata: null },
    { type: 'i16', nodata: null },
    { type: 'i16', nodata: -32768 },
    { type: 'f32', nodata: null },
    { type: 'f32', nodata: NaN, pickBands: [1] },
    { type: 'f32', nodata: -9999 },
  ];
  for (const c of cases) {
    it(`${c.type} nodata ${c.nodata}${c.pickBands ? ' with a decimated band' : ''}: levels 1–3 bit-identical, tiles with gutters`, async () => {
      // Odd sizes: partial tiles, odd child rows and columns at the right and bottom edges.
      const src = source({ width: 1537, height: 1029, bands: 2, ...c });
      const pyr = new Pyramid(src, new LRU(256 << 20));
      for (const L of [1, 2, 3]) {
        const { nx, ny } = pyr.tilesAt(L);
        for (let ty = 0; ty < ny; ty++)
          for (let tx = 0; tx < nx; tx++) {
            const want = await refCore(pyr, L, tx, ty, [0, 1]);
            const got = await pyr.coreGroup(L, tx, ty, [0, 1]);
            for (let q = 0; q < 2; q++) {
              expect([got[q].w, got[q].h]).toEqual([want[q].w, want[q].h]);
              same(got[q].data, want[q].data);
            }
          }
      }
      // Gutter gather (reference: the 2.1 base per-pixel lookup).
      for (const [L, tx, ty] of [[0, 1, 1], [0, 3, 2], [1, 0, 0], [1, 1, 1], [2, 0, 0]]) {
        const t = await pyr.tile(L, tx, ty, [1]);
        const { w: lw, h: lh } = pyr.dims(L);
        const { nx, ny } = pyr.tilesAt(L);
        const W = t.w;
        const ref = new (ctorFor(c.type))(W * t.h);
        for (let y = 0; y < t.h; y++)
          for (let x = 0; x < W; x++) {
            const ly = Math.min(lh - 1, Math.max(0, ty * TILE - GUTTER + y));
            const lx = Math.min(lw - 1, Math.max(0, tx * TILE - GUTTER + x));
            const cx = Math.floor(lx / TILE);
            const cy = Math.floor(ly / TILE);
            const core = cx < nx && cy < ny ? await pyr.core(L, cx, cy, 1) : null;
            ref[y * W + x] = core ? core.data[(ly - cy * TILE) * core.w + lx - cx * TILE] : 0;
          }
        same(t.bands[0], ref);
      }
    }, 60_000);
  }
});

describe('SICD amplitude (perf 2.1)', () => {
  it('magnitude() is the float32 of Math.hypot for float32 and int16 samples', () => {
    const r = rng(7);
    const f32 = new Float32Array(2);
    const check = (a, b) => {
      f32[0] = a;
      f32[1] = b;
      const want = Math.fround(Math.hypot(f32[0], f32[1]));
      const got = Math.fround(magnitude(f32[0], f32[1]));
      if (!Object.is(got, want)) throw new Error(`|${f32[0]} + ${f32[1]}i|: ${got} vs ${want}`);
    };
    for (let i = 0; i < 2e6; i++) {
      const e = Math.floor(r() * 60) - 30;
      check((r() - 0.5) * 2 ** e, (r() - 0.5) * 2 ** (e + Math.floor(r() * 8) - 4));
      check(Math.floor((r() - 0.5) * 65536), Math.floor((r() - 0.5) * 65536));
    }
    for (const [a, b] of [[0, 0], [-0, -0], [0, -0], [3, 4], [NaN, 1], [Infinity, NaN], [-Infinity, 2], [1e-45, 1e-45], [3.4e38, 3.4e38], [-3.4e38, 1]]) check(a, b);
  });
});
