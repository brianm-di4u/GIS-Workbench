// REQ-CNV-01 (S-32): the streaming COG writer — read back by geotiff.js, every level and tile
// matching the source; layout with overviews before full resolution.
import { describe, it, expect } from 'vitest';
import { fromArrayBuffer } from 'geotiff';
import { writeCogStream, cogLevels } from '../../app/src/formats/cog-stream.js';

describe('streaming COG', () => {
  it('levels halve until one tile', () => {
    expect(cogLevels(1300, 700, 256).map((l) => [l.width, l.height, l.step])).toEqual([[1300, 700, 1], [650, 350, 2], [325, 175, 4], [163, 88, 8]]);
  });
  it('writes a tiled, compressed, multi-level GeoTIFF read back exactly', async () => {
    const W = 1300;
    const H = 700;
    const n = 3;
    const val = (x, y, b) => (x * 7 + y * 13 + b * 101) % 4096;
    const reads = [];
    const levelsRead = new Set();
    const src = {
      width: W,
      height: H,
      bands: n,
      type: 'u16',
      read: async (k, x0, y0, w, h) => {
        reads.push(w * h);
        levelsRead.add(k);
        const s = 2 ** k;
        const a = new Uint16Array(w * h * n);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let b = 0; b < n; b++) a[(y * w + x) * n + b] = val(Math.min(W - 1, (x0 + x) * s), Math.min(H - 1, (y0 + y) * s), b);
        return a;
      },
    };
    let last = 0;
    const r = await writeCogStream(src, { tile: 256, epsg: 32611, geotransform: [500000, 0.5, 0, 3800000, 0, -0.5], photometric: 'rgb' }, (f) => (last = f));
    expect(last).toBe(1);
    expect(r.bigTiff).toBe(false);
    expect(Math.max(...reads)).toBeLessThanOrEqual(1300 * 256); // one tile row at a time
    expect([...levelsRead]).toEqual([0]); // overviews come from the rows written, not re-reads
    const buf = await r.blob.arrayBuffer();
    const tiff = await fromArrayBuffer(buf);
    expect(await tiff.getImageCount()).toBe(4);
    const im = await tiff.getImage(0);
    expect([im.getWidth(), im.getHeight(), im.getTileWidth(), im.getSamplesPerPixel()]).toEqual([1300, 700, 256, 3]);
    expect(im.getOrigin()).toEqual([500000, 3800000, 0]);
    const win = [1000, 500, 1300, 700];
    const rs = await im.readRasters({ window: win, interleave: true });
    let bad = 0;
    for (let y = 0; y < 200; y++) for (let x = 0; x < 300; x++) for (let b = 0; b < n; b++) if (rs[(y * 300 + x) * n + b] !== val(1000 + x, 500 + y, b)) bad++;
    expect(bad).toBe(0);
    const ov = await tiff.getImage(2);
    expect([ov.getWidth(), ov.getHeight()]).toEqual([325, 175]);
    const o = await ov.readRasters({ window: [10, 10, 11, 11], interleave: true });
    expect(Array.from(o)).toEqual([0, 1, 2].map((b) => val(40, 40, b)));
    // Cloud-optimized: the first IFD's tiles (full resolution) come after the overviews' tiles.
    const off0 = Math.min(...(await im.fileDirectory.loadValue('TileOffsets')));
    const offOv = Math.max(...(await ov.fileDirectory.loadValue('TileOffsets')));
    expect(off0).toBeGreaterThan(offOv);
  });
  it('writes BigTIFF (forced here; automatic past 4 GB)', async () => {
    const src = { width: 600, height: 300, bands: 1, type: 'f32', read: async (k, x0, y0, w, h) => Float32Array.from({ length: w * h }, (_, i) => (x0 + (i % w)) * 2 ** k + 0.25) };
    const r = await writeCogStream(src, { tile: 256, bigTiff: true });
    const buf = await r.blob.arrayBuffer();
    expect(new DataView(buf).getUint16(2, true)).toBe(43);
    const tiff = await fromArrayBuffer(buf);
    const im = await tiff.getImage(0);
    const [v] = await im.readRasters({ window: [599, 299, 600, 300] });
    expect(v[0]).toBe(599.25);
    expect(await tiff.getImageCount()).toBe(3);
  });
});
