// 2.5 vendor group (REQ-GAP-20): the JavaScript side of the vendor models and the Rust readers as
// the app calls them. The vendor bundle reads the corpus DigitalGlobe files, Landsat ANG and
// Sentinel-2 MTD_TL (gw_vendor_model); the core registers the record (gw_model_record); the model
// is checked against the product's own RPB, and the map + line-of-sight models against the map grid
// and the relief displacement. The geometry itself is validated by the cargo corpus tests
// (crates/gw-sensor/tests/vendor_*.rs); here the JS ↔ WASM plumbing is. Skips cleanly without the
// built WASM or without D:.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Core } from '../../app/src/wasm/core.js';
import { VendorBundle } from '../../app/src/wasm/vendor.js';
import { parseRpb } from '../../app/src/formats/open.js';
import { vendorNotes, landsatBand, s2Band, parseTilOffsets } from '../../app/src/sensor/vendor.js';

const target = (() => {
  try {
    return join(JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory, 'wasm32-unknown-unknown', 'release');
  } catch {
    return null;
  }
})();
const wasm = (n) => (target ? join(target, `gw_bundle_${n}.wasm`) : '');
const have = !!target && existsSync(wasm('core')) && existsSync(wasm('vendor'));
const core = have ? new Core(new WebAssembly.Module(readFileSync(wasm('core')))) : null;
const vendor = have ? new VendorBundle(new WebAssembly.Module(readFileSync(wasm('vendor')))) : null;
const TE = process.env.TE_CORPUS ?? 'D:/TE-corpus';
const WV2 = join(TE, 'eo-spacenet-atlanta-wv2-l1b-nadir10-nadir29/nadir29_315300_PAN/09DEC22163522-P1BS-058332847010_01_P003');
const L8 = join(TE, 'landsat8-c2-l1tp-044034-20240820-tierb/LC08_L1TP_044034_20240820_20240830_02_T1_ANG.txt');

describe('vendor metadata helpers', () => {
  it('names the bands of Landsat and Sentinel-2 band files', () => {
    expect(landsatBand('LC08_L1TP_044034_20240820_20240830_02_T1_B4.TIF')).toBe(4);
    expect(landsatBand('LC08_L1TP_044034_20240820_20240830_02_T1_B10.tif')).toBe(10);
    expect(landsatBand('LC08_L1TP_044034_20240820_20240830_02_T1_QA_PIXEL.TIF')).toBeNaN();
    expect(s2Band('T10SEH_20240816T184919_B04.jp2')).toBe(3);
    expect(s2Band('T10SEH_20240816T184919_B8A_20m.jp2')).toBe(8);
    expect(s2Band('T10SEH_20240816T184919_TCI.jp2')).toBeNaN();
  });
  it('reads .TIL tile offsets and words the reader notes', () => {
    const til = 'numTiles = 2;\nBEGIN_GROUP = TILE_1\n\tfilename = "A_R1C1.TIF";\n\tULColOffset = 0;\n\tULRowOffset = 0;\nEND_GROUP = TILE_1\nBEGIN_GROUP = TILE_2\n\tfilename = "A_R2C1.TIF";\n\tULColOffset = 0;\n\tULRowOffset = 8192;\nEND_GROUP = TILE_2\nEND;';
    expect(parseTilOffsets(til)).toEqual({ 'a_r1c1.tif': [0, 0], 'a_r2c1.tif': [0, 8192] });
    expect(vendorNotes({ flags: 0, sigma: [0.0441, 0.04, 0.065, 6.812] })[0]).toMatch(/0\.044 m in track.*6\.81 µrad/);
    expect(vendorNotes({ flags: 1 })[0]).toMatch(/avgLineRate/);
    expect(vendorNotes({ flags: 8, sigma: null })).toHaveLength(1);
  });
});

describe.skipIf(!have)('vendor models through the vendor and core bundles', () => {
  it.skipIf(!existsSync(`${WV2}.IMD`))('DigitalGlobe EPH/ATT/GEO/IMD → line scanner that agrees with the RPB (WorldView-2, 28° off nadir)', () => {
    const rd = (e) => readFileSync(`${WV2}.${e}`, 'latin1');
    const { header, record } = vendor.vendorModel(1, [rd('IMD'), rd('EPH'), rd('ATT'), rd('GEO')], 0);
    expect(header.type).toBe(2);
    expect(header.rows).toBe(17232);
    expect(header.cols).toBe(35180);
    expect(header.flags).toBe(0);
    expect(header.sigma?.[3]).toBeGreaterThan(0);
    const id = core.recordModel(2, record, 'Pushbroom (DigitalGlobe EPH/ATT/GEO, rigorous)');
    const rpc = core.rpcModel([...parseRpb(rd('RPB')), 0, 0, 0, 0, 0, 0]);
    const info = core.modelInfo(id);
    expect(info.is3d).toBe(true);
    let worst = 0;
    for (const [fx, fy] of [[0.1, 0.1], [0.5, 0.5], [0.9, 0.2], [0.3, 0.85]])
      for (const h of [-50, 300, 700]) {
        const x = fx * header.cols;
        const y = fy * header.rows;
        const g = core.i2g(rpc, x, y, h);
        const p = core.g2i(id, g.lat, g.lon, h);
        worst = Math.max(worst, Math.hypot(p.x - x, p.y - y));
      }
    // cargo vendor_dg_corpus: this product RMS 0.25 px, max 0.37 px over 363 points.
    expect(worst).toBeLessThan(0.5);
    // A priori covariance from the support data: the image covariance is stated.
    expect(core.imageCovariance(id, 1000, 1000, 300)?.[0]).toBeGreaterThan(0);
  });

  it('refuses a DigitalGlobe set with a missing part by name', () => {
    expect(() => vendor.vendorModel(1, ['numRows = 10;', '', '', ''], 0)).toThrow(/numColumns|IMD/);
  });

  it.skipIf(!existsSync(L8))('Landsat ANG → map + line of sight: the map grid on the reference surface, relief displacement above it', () => {
    const { header, record } = vendor.vendorModel(2, [readFileSync(L8, 'latin1')], 4, 32, 0);
    expect(header.type).toBe(4);
    expect([header.rows, header.cols]).toEqual([7811, 7671]);
    const id = core.recordModel(4, record, 'Map + line of sight (Landsat ANG)');
    const map = core.geotransformModel(Array.from(record.slice(0, 6)), record[6]);
    const g = core.i2g(map, 3000.5, 4000.5, 0);
    const p0 = core.g2i(id, g.lat, g.lon, 0);
    expect(Math.hypot(p0.x - 3000.5, p0.y - 4000.5)).toBeLessThan(1e-6);
    // 1000 m above the reference: a few pixels (view zenith up to 7.5° → ≤ 4.4 px at 30 m).
    const p1 = core.g2i(id, g.lat, g.lon, 1000);
    const d = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    expect(d).toBeGreaterThan(0.05);
    expect(d).toBeLessThan(4.5);
    const back = core.i2g(id, p1.x, p1.y, 1000);
    expect(Math.abs(back.lat - g.lat) * 111e3).toBeLessThan(1e-3);
  });

  it('refuses metadata that is not a vendor file it reads', () => {
    expect(() => vendor.vendorModel(2, ['GROUP = X\nEND_GROUP = X\n'], 4, 32, 0)).toThrow(/ANG/);
    expect(() => vendor.vendorModel(3, ['<xml/>'], 3, 32, 0)).toThrow(/MTD_TL/);
  });
});
