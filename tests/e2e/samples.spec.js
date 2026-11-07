// Samples regression (SDP §7 "Full" tier): every raster sample in Research/samples opens
// without a crash, a console error or a network request, and either renders or fails with
// the expected, named reason. Results go to reports/samples.json for the validation report.
// Covers REQ-FMT-01 (NITF 2.1/NSIF, IMODEs, blocking, masks, multiple segments, R-sets), REQ-FMT-02
// (JPEG 8/12-bit, JPEG 2000, VQ, T.4), REQ-DEM-01 and REQ-FMT-07 reading (DTED 0/1, SRTM HGT,
// GeoTIFF DEMs) and REQ-SEC-02 (hostile or unsupported input fails with a named error, never a hang).
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { openApp, openFiles, sample } from './helpers.js';

// [dir, files (first = primary, rest = sidecars), expected: 'render' | RegExp of the error,
//  allowed: RegExp of a known, named per-layer gap (other layers must still render)]
export const SAMPLES = [
  ['geotiff-gdal-small', ['small_world.tif'], 'render'],
  ['geotiff-gdal-small', ['utm.tif'], 'render'],
  ['geotiff-wv3-rpc-cog', ['wv3_a_cog.tif'], 'render'],
  ['geotiff-wv3-rpc-cog', ['wv3_a_gtiff_rpc.tif'], 'render'],
  ['dem-derived-s35w059', ['S35W059_crop1201_float32_cog.tif'], 'render'],
  ['dem-derived-s35w059', ['s35_w059_from_srtm.dt1'], 'render'],
  ['dted-gdal', ['n43.dt0'], 'render'],
  ['dted-gdal', ['w118n033.dt1'], 'render'],
  ['srtm-hgt-s35w059', ['S35W059.hgt.gz'], 'render'],
  ['jpeg-png-worldfile', ['small_world.jpg', 'small_world.jgw', 'small_world.jpg.aux.xml'], 'render'],
  ['jpeg-png-worldfile', ['small_world.png', 'small_world.pgw', 'small_world.png.aux.xml'], 'render'],
  ['msi-spacenet2-wv3', ['SN2_buildings_train_AOI_2_Vegas_MS_img10.tif'], 'render'],
  ['msi-spacenet2-wv3', ['SN2_buildings_train_AOI_2_Vegas_PS-RGB_img10.tif'], 'render'],
  ['nitf-wv3-mvs-stereo-chips', ['wv3_a_chip.ntf'], 'render'],
  ['nitf-wv3-mvs-stereo-chips', ['wv3_b_chip.ntf'], 'render'],
  ['nitf-wv3-mvs-stereo-chips', ['wv3_a_chip_j2k.ntf'], 'render'],
  ['nitf-gdal-autotest-small', ['i_3034c.ntf'], 'render'],
  ['nitf-gdal-autotest-small', ['fake_nsif.ntf'], 'render'],
  ['nitf-gdal-autotest-small', ['SENSRB_TRE.ntf'], 'render'],
  ['nitf-gdal-autotest-small', ['two_images_jpeg.ntf'], 'render'],
  ['nitf-gdal-autotest-small', ['two_images_jp2.ntf'], 'render'],
  ['nitf-gdal-rset', ['rset.ntf.r0', 'rset.ntf.r1', 'rset.ntf.r2'], 'render'],
  ['nitf-jitc-bitdepth', ['U_4005a.ntf'], 'render'],
  ['nitf-jitc-bitdepth', ['i_3430a.ntf'], 'render'],
  ['nitf-jitc-bitdepth', ['v_3402a.ntf'], 'render'],
  ['nitf-jitc-imode-bprs', ['U_3002a.ntf'], 'render'],
  ['nitf-jitc-imode-bprs', ['v_3301a.ntf'], 'render'],
  ['nitf-jitc-imode-bprs', ['v_3301h.ntf'], 'render'],
  ['nitf-jitc-imode-bprs', ['v_3310a.ntf'], 'render'],
  ['nitf-jitc-jpeg-c3', ['U_1005a.ntf'], 'render'],
  ['nitf-jitc-jpeg-c3', ['U_2005a.ntf'], 'render'],
  ['nitf-jitc-jpeg-c3', ['U_4017a.ntf'], 'render'],
  ['nitf-jitc-jpeg-c3', ['U_4020h.ntf'], 'render'],
  ['nitf-jitc-masked-nm', ['v_3301c.ntf'], 'render'],
  ['nitf-jitc-masked-nm', ['v_3301f.ntf'], 'render'],
  ['nitf-jitc-multiseg-graphics', ['U_1123a.ntf'], 'render', /T\.4 mode 2DS/], // 2-D T.4 segment: backlog
  ['nitf-jitc-multiseg-graphics', ['NITF21_CGM_ANNO_Uncompressed_unmasked.ntf'], 'render'],
  ['nitf-jitc-vq-cadrg', ['U_3058b.ntf'], 'render'],
  ['nitf-ntb-j2k-p0_01', ['p0_01a.ntf'], 'render'],
  ['nsif-jitc', ['ns3114a.nsf'], /no displayable image/], // text-only file (NUMI=0)
  ['nsif-jitc', ['nsif_N_3001a.nsf'], 'render'],
];

const results = [];
test.describe.configure({ mode: 'parallel' });

for (const [dir, files, expected, allowed] of SAMPLES) {
  test(`sample ${dir}/${files[0]}`, async ({ page }, info) => {
    const paths = files.map((f) => sample(dir, f));
    test.skip(!paths.every(existsSync), 'sample missing');
    const { frame, logs, requests } = await openApp(page, 'file');
    const t0 = Date.now();
    const log = await openFiles(frame, paths);
    const errors = log.flatMap((r) => r.errors ?? []);
    let rendered = false;
    if (!errors.length) {
      rendered = await frame
        .waitForFunction(() => {
          const ls = [...window.gisworkbench.layers.values()];
          return ls.length && ls.every((l) => l.error || (l.lutTex && !l.tiles?.loading));
        }, null, { timeout: 45_000 })
        .then(() => true, () => false);
    }
    const layerErrors = await frame.evaluate(() => [...window.gisworkbench.layers.values()].filter((l) => l.error).map((l) => l.error));
    const info2 = await frame.evaluate(() => [...window.gisworkbench.layers.values()].map((l) => ({ error: l.error ?? null, format: l.info.format, w: l.width, h: l.height, bands: l.bands, model: l.modelName ?? null, kind: l.kind })));
    const r = { browser: info.project.name, sample: `${dir}/${files[0]}`, expected: String(expected), rendered, errors, layerErrors, warnings: log.flatMap((x) => x.warnings ?? []), layers: info2, ms: Date.now() - t0 };
    results.push(r);
    mkdirSync('reports/samples', { recursive: true });
    writeFileSync(`reports/samples/${info.project.name}-${dir}-${files[0]}.json`, JSON.stringify(r, null, 1));
    expect(logs, 'console errors').toEqual([]);
    expect(requests, 'network requests').toEqual([]);
    if (expected === 'render') {
      expect(errors, 'open errors').toEqual([]);
      expect(rendered, 'rendered').toBe(true);
      for (const e of layerErrors) expect(e, 'layer error').toMatch(allowed ?? /^$/);
      expect(info2.some((l) => !l.error), 'at least one layer displays').toBe(true);
    } else {
      expect(errors.join(' ')).toMatch(expected);
    }
  });
}
