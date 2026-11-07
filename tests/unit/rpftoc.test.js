// RPF A.TOC mosaics (REQ-FMT-40) through app/src/workers/decode/rpftoc.js and the real `parse` and
// `legacy` WASM bundles, on the T&E corpus: the frame grid and georeferencing equal GDAL's RPFTOC
// subdatasets (origin and pixel size printed by gdalinfo 3.13), a window across four frames equals the
// frames read one by one, the polar zone 9 frame is placed in the ARC azimuthal plane, and a TOC with
// missing frames still opens. Skipped when the bundles or the corpus are absent.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openRpfToc, matchFrames } from '../../app/src/workers/decode/rpftoc.js';
import { frameCoverage } from '../../app/src/formats/rpf-coverage.js';
import { openNitf } from '../../app/src/workers/decode/nitf.js';
import { Bundle } from '../../app/src/wasm/abi.js';

const CORPUS = process.env.TE_CORPUS ?? resolve('..', 'TE-corpus');
const dir = (() => {
  try {
    return join(JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory, 'wasm32-unknown-unknown', 'release');
  } catch {
    return null;
  }
})();
const wasm = (n) => join(dir ?? '', `gw_bundle_${n}.wasm`);
const N35 = join(CORPUS, 'derived-rpf-cadrg-from-cib10', 'n35e011');
const Z9 = join(CORPUS, 'raster-gdal-autotest-dimap2-rpf-nm', 'rpftoc', 'zone9');
const have = dir && existsSync(wasm('parse')) && existsSync(wasm('legacy')) && existsSync(N35) && existsSync(Z9);

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
function folder(root) {
  const all = walk(root).map((p) => {
    const f = new File([readFileSync(p)], p.split(/[\\/]/).pop());
    f.relPath = p.slice(root.length + 1).replace(/\\/g, '/');
    return f;
  });
  return { toc: all.find((f) => /^a\.toc$/i.test(f.name)), frames: all.filter((f) => !/^a\.toc$/i.test(f.name)) };
}

describe.skipIf(!have)('RPF A.TOC', { timeout: 60000 }, () => {
  const bundles = () => ({ parse: new Bundle(new WebAssembly.Module(readFileSync(wasm('parse'))), 'parse'), legacy: new Bundle(new WebAssembly.Module(readFileSync(wasm('legacy'))), 'legacy') });

  it('CADRG 1:50k zone 2: GDAL grid and georeferencing; windows across frames', async () => {
    const { toc, frames } = folder(N35);
    const b = bundles();
    const r = await openRpfToc(toc, frames, b);
    expect(r.missing).toBe(0);
    expect(r.sources).toHaveLength(1);
    const s = r.sources[0];
    // gdalinfo NITF_TOC_ENTRY:CADRG__50K_2_0: 12288 × 15360, origin (10.9187817…, 35.0124688…), pixel 8.9229e-5 × 6.7440e-5.
    expect([s.width, s.height, s.bands, s.sampleType]).toEqual([12288, 15360, 3, 'u8']);
    expect(s.georef.code).toBe(4326);
    expect(s.georef.gt[0]).toBeCloseTo(10.918781725888323, 9);
    expect(s.georef.gt[3]).toBeCloseTo(35.012468827930178, 9);
    expect(s.georef.gt[1]).toBeCloseTo(0.000089229060914, 12);
    expect(s.georef.gt[5]).toBeCloseTo(-0.000067439574142, 12);
    // A window over the corner of four frames equals the frames themselves.
    const win = await s.readWindow(1536 * 3 - 20, 1536 * 4 - 10, 40, 20, [0, 1, 2]);
    const byCell = new Map(r.toc.boundaries[0].frames.map((fr) => [`${fr.row},${fr.col}`, fr]));
    const files = matchFrames(r.toc, frames);
    for (const [x, y] of [[0, 0], [39, 0], [0, 19], [39, 19], [20, 10]]) {
      const X = 1536 * 3 - 20 + x;
      const Y = 1536 * 4 - 10 + y;
      const fr = byCell.get(`${Math.floor(Y / 1536)},${Math.floor(X / 1536)}`);
      const f = files.get(`${fr.dir.toLowerCase()}|${fr.file.toLowerCase()}`);
      const one = (await openNitf(f, b.parse)).sources[0];
      const px = await one.readWindow(X % 1536, Y % 1536, 1, 1, [0, 1, 2]);
      for (let k = 0; k < 3; k++) expect(win[k][y * 40 + x], `(${x},${y}) band ${k}`).toBe(px[k][0]);
    }
    const fc = frameCoverage(r.toc);
    expect(fc.features).toHaveLength(r.toc.boundaries[0].frames.length);
  });

  it('polar zone 9: the frame is placed in the ARC azimuthal equidistant plane (GDAL origin)', async () => {
    const { toc, frames } = folder(Z9);
    const r = await openRpfToc(toc, frames, bundles());
    const g = r.sources[0].georef;
    expect(g.code).toBe(990009);
    // gdalinfo: Origin = (806106.657468533, 345474.281772229), Pixel Size = (149.945434796974, -149.945434796974).
    expect(g.gt[0]).toBeCloseTo(806106.657468533, 3);
    expect(g.gt[3]).toBeCloseTo(345474.281772229, 3);
    expect(g.gt[1]).toBeCloseTo(149.945434796974, 6);
    expect(frameCoverage(r.toc).features).toHaveLength(0); // polar cells are not drawn from the TOC alone
  });

  it('missing frames read as nodata; no frames at all is an error by name', async () => {
    const { toc, frames } = folder(N35);
    const r = await openRpfToc(toc, frames.slice(0, 5), bundles());
    expect(r.missing).toBe(r.toc.boundaries[0].frames.length - 5);
    const s = r.sources[0];
    const empty = r.toc.boundaries[0].frames.find((fr) => !r.used.includes(fr.file));
    const [px] = await s.readWindow(empty.col * 1536 + 100, empty.row * 1536 + 100, 4, 4, [0]);
    expect([...px].every((v) => v === 0)).toBe(true);
    const none = await openRpfToc(toc, [], bundles());
    expect(none.sources).toHaveLength(0);
    expect(none.notes.join(' ')).toMatch(/none of its \d+ frame files was given/);
  });
});
