// TE-C01 Phase 1 ingest conformance: every primary file of every corpus item on disk opens without
// a console error, CSP violation or network request, and either displays or is refused with a
// named reason. Raster dimensions and band counts are compared with GDAL truth (oracles/raster.py).
// Covers REQ-FMT-01..13, REQ-FMT-16 (every public sample opens), REQ-SEC-02, REQ-DEM-01, REQ-LDR-01,
// REQ-SAR-01, REQ-MSI-01, REQ-FMV-01, REQ-EXT-21/22.
import { test, expect } from '@playwright/test';
import { existsSync, statSync } from 'node:fs';
import { openApp, openFiles, settledAny, registries, record, truth, ASCII_CRS } from './helpers.js';
import { EXPECT, cases, reqsFor, refusedKeys, GENERIC, ROBUST } from './cases.js';

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
    const epsg = ASCII_CRS[f.name.split('/').pop()] ?? null;
    await frame.evaluate((e) => Object.assign(window.gisworkbench, { zipPick: 'default', asciiPick: e ? { epsg: e } : 'default', relinkPick: 'skip' }), epsg);
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
    // A single 3D Tiles content file or terrain tile is refused with the way to open its tile set.
    const tilePart = /\.(b3dm|i3dm|pnts|cmpt|subtree|terrain)$/i.test(name) ? { refuse: /3D Tiles content tile|quantized-mesh terrain tile/ } : null;
    const exp = EXPECT[`${name}#${f.name.split('/').slice(-2, -1)[0] ?? ''}`] ?? EXPECT[name] ?? tilePart ?? {};
    // Truth is keyed by the path in the item when a file name repeats in several folders.
    const tf = truth(it.id)?.files;
    const gdal = tf?.[f.name] ?? tf?.[name];
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
    const refused = refusedKeys(it, f);
    if (refused.length) {
      const said = [...errors, ...layers.filter((l) => l.error).map((l) => l.error), ...toasts.filter((t) => /^toast-(error|warn)/.test(t))].join(' | ');
      expect(said, `a ${refused.join('/')} sample is refused`).not.toBe('');
      return expect(said, `the refusal names the format (${refused.join('/')})`).not.toMatch(GENERIC);
    }
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
