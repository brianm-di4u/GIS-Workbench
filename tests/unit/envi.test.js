// ENVI raw reader (app/src/workers/decode/envi.js): BSQ/BIL/BIP windows equal the reference cube
// whichever read path serves them (per-band runs for a few BIL bands, whole lines for many), and the
// strided coarse levels of a large cube pick the centre sample of each 2^L cell.
import { describe, it, expect } from 'vitest';
import { enviSource } from '../../app/src/workers/decode/envi.js';

const W = 37;
const H = 23;
const NB = 9;
const val = (b, y, x) => b * 10000 + y * 100 + x;

function cube(il) {
  const f = new Float32Array(W * H * NB);
  for (let b = 0; b < NB; b++)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = il === 'bsq' ? (b * H + y) * W + x : il === 'bil' ? (y * NB + b) * W + x : (y * W + x) * NB + b;
        f[i] = val(b, y, x);
      }
  const hd = { samples: W, lines: H, bands: NB, headerOffset: 0, interleave: il, byteOrder: 0, dataType: 4, sizeOk: true, ignore: NaN };
  return enviSource(new File([f.buffer], `c.${il}`), hd);
}

describe('ENVI', () => {
  for (const il of ['bsq', 'bil', 'bip']) {
    it(`${il}: few-band and all-band windows equal the cube`, async () => {
      const src = cube(il);
      for (const bands of [[0, 4, 8], [...Array(NB).keys()]]) {
        const out = await src.readWindow(5, 3, 20, 11, bands);
        for (let k = 0; k < bands.length; k++) for (let y = 0; y < 11; y++) for (let x = 0; x < 20; x++) expect(out[k][y * 20 + x]).toBe(val(bands[k], 3 + y, 5 + x));
      }
    });
    it(`${il}: a strided coarse level samples cell centres`, async () => {
      const src = cube(il);
      const L = 2;
      const out = await src.readLevel(L, 1, 1, 5, 3, [2, 7]);
      for (let k = 0; k < 2; k++)
        for (let j = 0; j < 3; j++)
          for (let i = 0; i < 5; i++) {
            const X = (1 + i) * 4 + 2;
            const Y = (1 + j) * 4 + 2;
            if (X < W && Y < H) expect(out[k][j * 5 + i]).toBe(val([2, 7][k], Y, X));
          }
    });
  }
  it('native levels only for large cubes', () => {
    expect(cube('bil').hasLevel(2)).toBe(false);
  });
});
