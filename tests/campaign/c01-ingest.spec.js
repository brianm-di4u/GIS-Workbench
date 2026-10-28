// TE-C01 Phase 1 ingest conformance: every primary file of every corpus item on disk opens without
// a console error, CSP violation or network request, and either displays or is refused with a
// named reason. Raster dimensions and band counts are compared with GDAL truth (oracles/raster.py).
// Covers REQ-FMT-01..13, REQ-FMT-16 (every public sample opens), REQ-SEC-02, REQ-DEM-01, REQ-LDR-01,
// REQ-SAR-01, REQ-MSI-01, REQ-FMV-01, REQ-EXT-21/22.
import { test, expect } from '@playwright/test';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles, settledAny, registries, record, manifest, paths, truth } from './helpers.js';
import { filePath } from '../../build/campaign/corpus-lib.mjs';

// HDF5/NetCDF (EMIT, PRISMA) need the h5wasm data pack; a user opens it first (File ▸ Open Data Pack).
const HDF5_PACK = (() => {
  const dir = resolve('dist', 'packs');
  const f = existsSync(dir) && readdirSync(dir).find((n) => /^hdf5-.*\.gwpack$/.test(n));
  return f ? resolve(dir, f) : null;
})();

// Named refusals and per-layer gaps already accepted (keep in step with tests/e2e/samples.spec.js).
const EXPECT = {
  'ns3114a.nsf': { refuse: /no displayable image/ },
  // TE-047: 4607 files with neither dwells nor platform locations are refused by name, listing their segments.
  'free_text_and_test_status.gmti': { refuse: /no dwell or platform location segments/ },
  'processing_history_chain.gmti': { refuse: /no dwell or platform location segments/ },
  // TE-010: NITF 2.0 conformance files with no image segment (GDAL: 0 bands).
  ...Object.fromEntries(['U_1051e', 'U_1052a', 'U_1056a', 'U_1060a', 'U_1064a', 'U_1068a', 'U_0006a'].map((n) => [`${n}.ntf`, { refuse: /no displayable image/ }])),
  // TE-011: NITF 1.1 is a Could; refused by name.
  ...Object.fromEntries(['U_0001a', 'U_0001b', 'U_0001c', 'U_0002a', 'U_0004a', 'U_0005a'].map((n) => [`${n}.ntf`, { refuse: /NITF01\.10/ }])),
  // TE-012: truncated RPF test file (GDAL fails too).
  'testtest.on9': { refuse: /mask table|truncat|DES/ },
  // TE-030: CPHD holds no image; refused by name.
  'umbra_20230925_CPHD.cphd': { refuse: /CPHD/ },
  'capella_C13_SM_CPHD.cphd': { refuse: /CPHD/ },
  // Draco-compressed glTF needs a Draco decoder (not bundled): refused by name.
  'Box.gltf#glTF-Draco': { refuse: /DRACO|Draco/ },
  // TE-016: transport streams with the PAT or PMT removed are refused by name (no hang).
  'mpegts-remove-PAT.ts': { refuse: /PAT\/PMT|damaged/ },
  'mpegts-remove-PMT.ts': { refuse: /PAT\/PMT|damaged/ },
  // An attribute-only CSV (GDAL opens it as a table with no geometry): refused as not spatial.
  'testcsvt.csv': { refuse: /no WKT column and no longitude\/latitude/ },
  // Country/world-scale vector files above the in-memory limit (TE-024, OD-07): refused by name, fast.
  'natural_earth_vector.gpkg.zip': { refuse: /read whole into memory/ },
  'natural_earth_vector.gpkg': { refuse: /read whole into memory/ },
  'colorado-latest-free.shp.zip': { refuse: /read whole into memory/ },
  'colorado-latest-free.gpkg.zip': { refuse: /read whole into memory/ },
  'colorado.gpkg': { refuse: /read whole into memory/ },
  // TE-061: MrSID (proprietary wavelet codec) is refused by name with its size; decoding is OD-10.
  'Hamilton_2018_rgb_20x.sid': { refuse: /MrSID \(MG3; 340,000 × 220,000 px, 3 bands, 8-bit\)/ },
  'Stl_City.sid': { refuse: /MrSID \(MG3; 98,304 × 188,416 px, 3 bands, 8-bit\)/ },
};
// Robustness seeds are malformed on purpose: they must fail by name (no console error, no hang).
const ROBUST = (it) => it.area === 'robustness' || it.id === 'gdal-autotest-dted-edge';
const SKIP_EXT = /\.(txt|json|xml|html?|md|pdf\.aux\.xml)$/i;

const cases = [];
for (const it of manifest.items) {
  // Tier-B (login) items are ingested once the owner has downloaded them; absent files skip below.
  // Tier U is field data a user supplied (build/campaign/field.mjs, phase F).
  if (!['A', 'B', 'U'].includes(it.tier) && it.origin !== 'research-samples') continue;
  const sidecars = paths(it, ['sidecar']);
  for (const f of it.files.filter((x) => (x.role ?? 'primary') === 'primary' && !SKIP_EXT.test(x.name))) {
    // By the full relative name: sample sets repeat one file name in several folders (glTF variants).
    const prim = filePath(it, f);
    const stem = f.name.split('/').pop().replace(/\.[^.]+$/, '');
    const base = (p) => p.split(/[\\/]/).pop();
    const dir = (p) => p.replace(/[\\/][^\\/]*$/, '');
    // A .gltf is opened with the buffers and textures beside it, as a user would select them.
    const res = /\.gltf$/i.test(f.name) ? paths(it, ['primary', 'sidecar', 'test-vector']).filter((p) => p !== prim && dir(p) === dir(prim) && /\.(bin|png|jpe?g|webp|ktx2)$/i.test(p)) : [];
    const pack = HDF5_PACK && /\.(nc|h5|he5|hdf5)$/i.test(f.name) ? [HDF5_PACK] : [];
    cases.push({ it, f, files: [...pack, prim, ...res, ...sidecars.filter((s) => base(s).startsWith(`${stem}.`) || base(s).startsWith(`${f.name.split('/').pop()}.`))] });
  }
}

// Requirement IDs by format, so traceability gets a last result per format (incl. TE_REQS rows).
const reqsFor = (it, f) => {
  const n = f.name.toLowerCase();
  const r = ['REQ-FMT-16'];
  if (/\.(jp2|j2k|j2c|jpx)$/.test(n)) r.push('REQ-FMT-18');
  if (/\.gpkg$/.test(n) && /tile|raster|3857|denver|elevation/.test(n + it.id)) r.push('REQ-FMT-19');
  if (it.area === 'lidar') r.push('REQ-LDR-01', 'REQ-LDR-13');
  if (/\.(ntf|nitf|nsf)$/.test(n)) r.push('REQ-FMT-01');
  if (/\.(tif|tiff)$/.test(n)) r.push('REQ-FMT-04');
  if (it.area === 'fmv') r.push('REQ-FMV-01');
  if (it.area === 'vector') r.push('REQ-EXT-21');
  if (it.area === 'sar') r.push('REQ-SAR-01');
  if (it.area === 'dem') r.push('REQ-DEM-01');
  if (it.area === 'hsi' || it.area === 'landsat' || it.area === 'sentinel2' || it.area === 'naip') r.push('REQ-MSI-01');
  if (it.area === 'robustness') r.push('REQ-SEC-02');
  return r.join(' ');
};

test.describe.configure({ mode: 'parallel' });
for (const { it, f, files } of cases) {
  test(`TE-C01 ${reqsFor(it, f)} ${it.id}/${f.name} [${it.format}]`, async ({ page }, info) => {
    test.skip(!files.every((p) => p && existsSync(p)), 'not on disk (run build/campaign/fetch.mjs)');
    // Very large files (country-scale vectors, 1 GB SAR) get time to finish so their import time
    // is measured (TE-024) rather than cut off.
    const bytes = files.reduce((t, p) => t + statSync(p).size, 0);
    if (bytes > 200e6) test.setTimeout(900_000);
    const { frame, logs, requests, csp } = await openApp(page, 'file');
    // Imagery ZIPs open their default selection without the picker (IMP-21).
    await frame.evaluate(() => (window.gisworkbench.zipPick = 'default'));
    const t0 = Date.now();
    const log = await openFiles(frame, files);
    const errors = log.flatMap((r) => r.errors ?? []);
    // openFiles resolves after the import; give the slower routes (clouds, video) time to register.
    const rendered = errors.length ? false : await settledAny(frame, 0, bytes > 200e6 ? 840_000 : 120_000);
    const layers = await frame.evaluate(() => [...window.gisworkbench.layers.values()].map((l) => ({ error: l.error ?? null, kind: l.kind, format: l.info?.format, w: l.width, h: l.height, bands: l.bands, model: l.modelName ?? null })));
    // Non-raster routes keep their own registries: vector layers, point clouds, video clips.
    const others = await registries(frame);
    const ms = Date.now() - t0;
    // What the user saw: vector/point-cloud/motion routes report through toasts, not only importLog.
    const toasts = await frame.evaluate(() => [...document.querySelectorAll('.toasts .toast')].map((t) => `${[...t.classList].find((c) => c.startsWith('toast-'))}: ${t.textContent}`));
    const name = f.name.split('/').pop();
    const exp = EXPECT[`${name}#${f.name.split('/').slice(-2, -1)[0] ?? ''}`] ?? EXPECT[name] ?? {};
    const gdal = truth(it.id)?.files?.[name];
    const diffs = [];
    const img = layers.find((l) => !l.error && l.w);
    // GDAL rasterises PDFs at 150 DPI; the app composites at the images' native resolution.
    if (gdal?.kind === 'raster' && !gdal.error && img && !gdal.subdatasets && gdal.driver !== 'PDF') {
      // GPKG tile sets: the app keeps the tile matrix's native (possibly anisotropic) pixels over the
      // occupied window; GDAL resamples to square pixels over gpkg_contents (c20 checks the corners).
      if (gdal.driver !== 'GPKG' && (img.w !== gdal.width || img.h !== gdal.height)) diffs.push(`size ${img.w}×${img.h} vs GDAL ${gdal.width}×${gdal.height}`);
      // GDAL reports tile GeoPackages as RGBA; the app keeps RGB.
      if (img.bands && gdal.bands && !gdal.palette && !gdal.complex && !(gdal.driver === 'GPKG' && gdal.bands === 4 && img.bands <= 3) && img.bands !== gdal.bands) diffs.push(`bands ${img.bands} vs GDAL ${gdal.bands}`);
    }
    const cspv = await csp();
    record('c01-ingest', info.project.name, { key: `${it.id}/${name}`, item: it.id, file: name, format: it.format, rendered, errors, warnings: log.flatMap((x) => x.warnings ?? []), toasts, layers, others, diffs, ms, logs, requests, csp: cspv });
    expect(logs, 'console errors').toEqual([]);
    expect(requests, 'network requests').toEqual([]);
    expect(cspv, 'CSP violations').toEqual([]);
    if (exp.refuse) return expect([...errors, ...layers.filter((l) => l.error).map((l) => l.error), ...toasts].join(' ')).toMatch(exp.refuse);
    if (ROBUST(it)) {
      // Either a clean open (some seeds are recoverable) or a named refusal; never a raw JS exception.
      const said = [...errors, ...layers.filter((l) => l.error).map((l) => l.error)].join(' | ');
      return expect(said, 'malformed input fails with a named reason (SEC-02)').not.toMatch(/DataView|MAX_SAFE_INTEGER|array buffer length|Failed to fetch|is not a function|undefined|Expected \w+ to be/);
    }
    expect(errors, 'open errors (or add a named refusal to EXPECT)').toEqual([]);
    expect(toasts.filter((t) => t.startsWith('toast-error')), 'error toasts').toEqual([]);
    const opened = layers.length + others.vlayers + others.clouds + others.clips + log.length;
    expect(opened || toasts.some((t) => /^toast-(info|success): Opened/.test(t)), 'something was opened (silent no-op is a finding)').toBeTruthy();
    for (const l of layers.filter((x) => x.error)) expect(l.error, 'layer error').toMatch(exp.allowLayer ?? /^$/);
    if (layers.some((l) => l.kind === 'image')) expect(rendered, 'rendered').toBe(true);
    expect(diffs, 'metadata vs GDAL').toEqual([]);
  });
}
