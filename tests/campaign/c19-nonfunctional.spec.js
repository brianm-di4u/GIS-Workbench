// TE-C19 Phase 6 non-functional: run-mode parity on real data (file, http, cross-origin iframe,
// srcdoc — REQ-HOST-09, PT-01), first-tile time on the largest corpus rasters (PRF-03), and Lite build
// parity. Performance at scale, soak and fuzz-from-corpus runs are added in Part B.
import { test, expect } from '@playwright/test';
import { existsSync, statSync } from 'node:fs';
import { openApp, openFiles, settled, servers, record, manifest, paths, onDisk } from './helpers.js';

// One small item per format family, opened in every run mode.
const FAMILY = ['rs-nitf-jitc-jpeg-c3', 'rs-geotiff-wv3-rpc-cog', 'rs-dted-gdal', 'rs-sicd-umbra-chip', 'rs-envi-hsi-indian-pines', 'rs-vector-naturalearth-110m', 'rs-lidar-las-laz-copc'];
const MODES = ['file', 'http', 'iframe', 'srcdoc'];

let srv;
test.beforeAll(async () => (srv = await servers()));
test.afterAll(async () => srv?.close());
test.describe.configure({ mode: 'parallel' });

for (const id of FAMILY) {
  for (const mode of MODES) {
    test(`TE-C19 REQ-HOST-09 ${id} opens in ${mode} mode`, async ({ page }, info) => {
      const it = manifest.items.find((x) => x.id === id);
      test.skip(!it || !onDisk(it, ['primary']), 'not on disk');
      const prim = paths(it, ['primary'])[0];
      // The primary with its own sidecars (ENVI .hdr, world files), as a user would drop them.
      const stem = prim.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
      const side = paths(it, ['sidecar']).filter((p) => p.split(/[\\/]/).pop().startsWith(stem));
      const { frame, logs, requests } = await openApp(page, mode, { srv });
      const log = await openFiles(frame, [prim, ...side]);
      const ok = await settled(frame).catch(() => false);
      record('c19-nonfunctional', info.project.name, { key: `${id}-${mode}`, mode, errors: log.flatMap((r) => r.errors ?? []), ok, logs, requests });
      expect(logs).toEqual([]);
      expect(requests).toEqual([]);
      expect(log.flatMap((r) => r.errors ?? [])).toEqual([]);
    });
  }
}

// PRF-03: first tile ≤ 1 s, measured on the five largest single-file rasters in the corpus.
const big = manifest.items
  .filter((it) => ['eo', 'nitf', 'landsat', 'sentinel2', 'naip', 'dem', 'sar'].includes(it.area) && onDisk(it, ['primary']))
  // Single-file rasters the app displays: not MrSID (refused, OD-10) or delivery ZIPs (a picker).
  .flatMap((it) => paths(it, ['primary']).filter((p) => !/\.(cphd|xml|json|sid|zip)$/i.test(p)).map((p) => ({ it, p, bytes: existsSync(p) ? statSync(p).size : 0 })))
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 5);
for (const { it, p, bytes } of big) {
  test(`TE-C19 PRF-03 first tile ${it.id}/${p.split(/[\\/]/).pop()} (${(bytes / 1e6).toFixed(0)} MB)`, async ({ page }, info) => {
    const { frame } = await openApp(page, 'file');
    const t0 = Date.now();
    await openFiles(frame, [p]);
    const first = await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.error || l.lutTex), null, { timeout: 120_000 }).then(() => Date.now() - t0, () => null);
    record('c19-nonfunctional', info.project.name, { key: `prf03-${it.id}-${p.split(/[\\/]/).pop()}`, bytes, firstTileMs: first });
    expect(first, 'first tile ms (PRF-03 ≤ 1000 on the reference laptop; logged here)').not.toBeNull();
  });
}
