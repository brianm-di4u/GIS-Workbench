// SCN-60, REQ-GAP-72 on real data: HDF-EOS grids and swaths, FITS images, cubes and extensions, KEA and
// TileDB, through real jobs of raster-cog, raster-sds-cog, export-gdal and raster-tiledb. Every pixel is
// checked against a reader that is not GDAL (tests/tools/plugindata_oracle.py: pyhdf, astropy, h5py,
// tiledb-py, tifffile). The data is not in the repository: without it each test skips.
//
// Env: GWB_PLUGINDATA (default E:/gwb26/data-plugindata, with SOURCES.json), GWB_PLUGINDATA_PY (Python of
// the oracle), GWB_PLUGINDATA_QUICK (three subdatasets a file, no 10 GB image), GWB_PLUGINDATA_SRC (a large
// GeoTIFF for KEA and TileDB), GWB_PLUGINDATA_NO_LARGE (leave out the 10 GB files, whose job folders need
// 20 GB on the native disk). Results: reports/sidecar/plugindata-<platform>.json.
// The spec needs no browser and starts its own sidecars, so it may run with --no-deps. Take the
// sidecar-e2e lock all the same.

import { test, expect } from '@playwright/test';
import { dirname, join, resolve, basename } from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { EXE, MODULES, DATA_ROOT, LINUX } from './harness.js';
import { DATA, PY, openSidecar, oracle, runJob, hdf4Case, fitsCase, badCase, keaCase, tiledbExport, dropOutputs } from './plugindata-lib.mjs';

const QUICK = !!process.env.GWB_PLUGINDATA_QUICK;
const PORT = Number(process.env.GWB_PLUGINDATA_PORT ?? 47825);
// Landlock cannot hold a rule on a /mnt drive in WSL, so on Linux the job folders stay on the native disk.
const WORK = process.env.GWB_PLUGINDATA_WORK ?? (LINUX ? join(DATA_ROOT, 'plugindata-spec') : join(DATA, 'run', 'spec-windows'));
// Files the oracle opens with HDF5 or TileDB stay where a Windows Python reaches them as a plain path.
const SHARED = join(DATA, 'run', LINUX ? 'spec-linux-shared' : 'spec-windows-shared');
const SRC = process.env.GWB_PLUGINDATA_SRC ?? `${LINUX ? '/mnt/e' : 'E:'}/TE-corpus/naip-co-roumelis-2023/m_4010520_sw_13_030_20230821_20240104.tif`;
const REPORT = resolve('reports', 'sidecar', `plugindata-${LINUX ? 'linux' : 'windows'}.json`);
const results = {};
const record = (k, v) => {
  results[k] = v;
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), platform: process.platform, quick: QUICK, results }, null, 1));
};
const ls = (...d) => {
  const p = join(DATA, ...d);
  return existsSync(p) ? readdirSync(p).filter((n) => !n.endsWith('.aux.xml')).map((n) => join(p, n)) : [];
};
const ready = (paths) => existsSync(PY) && existsSync(EXE) && paths.length > 0;

/** One sidecar for `picks`; each picked file goes to `run`. */
async function withFiles(name, picks, run) {
  const sc = await openSidecar({ exe: EXE, modules: MODULES, dataDir: join(WORK, name), port: PORT, picks });
  const rows = [];
  try {
    for (const f of sc.files) {
      const path = picks.find((p) => basename(p) === f.name);
      rows.push(await run(sc, { ...f, path }, path));
    }
  } finally {
    sc.stop();
    record(name, rows);
    rmSync(join(WORK, name), { recursive: true, force: true });
  }
  return rows.flatMap((r) => r.problems.map((p) => `${r.file}: ${p}`));
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(8 * 3600_000);

test('REQ-GAP-72 HDF-EOS grids: listing, pixels, fill, scale, the MODIS sinusoidal grid', async () => {
  const files = ls('hdf4', 'grid');
  test.skip(!ready(files), 'no data or no oracle');
  expect(await withFiles('hdf4-grid', files, hdf4Case)).toEqual([]);
});

test('REQ-GAP-72 HDF-EOS swaths: MODIS L1B and L2, ASTER L1B, band order, tie points', async () => {
  const files = ls('hdf4', 'swath');
  test.skip(!ready(files), 'no data or no oracle');
  expect(await withFiles('hdf4-swath', files, hdf4Case)).toEqual([]);
});

test('REQ-GAP-72 FITS: BITPIX -32, -64, 16, 32, BSCALE and BLANK, cube, extensions, tile compression', async () => {
  const files = ['bscale', 'dss16', 'nasa-samples', 'fz', 'bitpix64', 'jwst-cal', 'cube', 'cube-small', 'mef-kepler', 'table'].flatMap((d) => ls('fits', d));
  test.skip(!ready(files), 'no data or no oracle');
  expect(await withFiles('fits', files, fitsCase)).toEqual([]);
});

test('REQ-GAP-72 FITS: the 10 GB image and the JWST mosaic, every pixel', async () => {
  const files = [...ls('fits', 'large'), ...ls('fits', 'mef-jwst')];
  test.skip(QUICK || !!process.env.GWB_PLUGINDATA_NO_LARGE || !ready(files), 'no data, no oracle, or a quick run');
  expect(await withFiles('fits-large', files, (sc, f, path) => fitsCase(sc, f, path, { hdus: 0 }))).toEqual([]);
});

test('REQ-GAP-72 damaged and mislabelled files are refused by name, and leave nothing', async () => {
  const files = ls('bad');
  test.skip(!ready(files), 'no data or no oracle');
  expect(await withFiles('bad', files, badCase)).toEqual([]);
});

test('REQ-GAP-72 KEA: a large real raster to KEA and back, against h5py and the source', async () => {
  test.skip(!existsSync(PY) || !existsSync(EXE) || !existsSync(SRC), 'no data or no oracle');
  const problems = await withFiles('kea', [SRC], async (sc, f, path) => {
    mkdirSync(SHARED, { recursive: true });
    const back = join(SHARED, 'kea-back.kea');
    const r = await keaCase(sc, f, { compare: path, via: back });
    if (!r.row) return r;
    const { row, j } = r;
    // From the job's KEA to a COG, through a second sidecar that can pick it.
    await dropOutputs(sc, j);
    const sc2 = await openSidecar({ exe: EXE, modules: MODULES, dataDir: join(WORK, 'kea2'), port: PORT + 1, picks: [back] });
    try {
      const c = await runJob(sc2, 'raster-cog', [sc2.files[0].id], {});
      row.back = { state: c.state, seconds: c.seconds, peak_mb: c.peak_mb, error: c.error };
      if (c.state !== 'succeeded') row.problems.push(`KEA to COG: ${c.error}`);
      else {
        const m = oracle('kea-check', back, c.path);
        row.back.h5py = m;
        if (!m.equal) row.problems.push(`COG from KEA differs in ${m.different} values`);
      }
    } finally {
      sc2.stop();
      rmSync(back, { force: true });
      rmSync(join(WORK, 'kea2'), { recursive: true, force: true });
    }
    return row;
  });
  expect(problems).toEqual([]);
});

test('REQ-GAP-72 export-gdal refuses a writer that makes a folder, by name, before it runs', async () => {
  test.skip(!existsSync(EXE) || !existsSync(SRC), 'no data');
  const problems = await withFiles('folder-writer', [SRC], async (sc, f) => {
    const r = await runJob(sc, 'export-gdal', [f.id], { driver: 'TileDB' });
    return { file: f.name, error: r.error, problems: r.state === 'refused' && /writes a folder/.test(r.error) ? [] : [`${r.state}: ${r.error}`] };
  });
  expect(problems).toEqual([]);
});

test('REQ-GAP-72 TileDB: a large real raster to an array through a job, read back through a job', async () => {
  test.skip(!existsSync(PY) || !existsSync(EXE) || !existsSync(SRC), 'no data or no oracle');
  const dir = join(SHARED, 'tiledb-array');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const problems = await withFiles('tiledb', [SRC], async (sc, f) => {
    const row = await tiledbExport(sc, f, dir);
    if (row.problems.length) return row;
    const array = join(dir, 'array.tdb');
    const t = oracle('tiledb-check', array, f.path);
    row.tiledb_py = t;
    if (!t.equal) row.problems.push(`array differs in ${t.different} of ${t.pixels} values`);
    // The unpacked array is a raster input: a folder, picked, through raster-cog, and probed as one.
    const sc2 = await openSidecar({ exe: EXE, modules: MODULES, dataDir: join(WORK, 'tdb2'), port: PORT + 1, picks: [array] });
    try {
      const id = sc2.files[0].id;
      const p = await runJob(sc2, 'probe', [id]);
      row.probe = p.result?.match;
      if (p.result?.match?.format !== 'TileDB') row.problems.push(`probe says ${JSON.stringify(p.result?.match)}: ${p.error}`);
      const c = await runJob(sc2, 'raster-cog', [id], {});
      row.back = { state: c.state, seconds: c.seconds, peak_mb: c.peak_mb, output: c.outputs?.[0]?.size, error: c.error };
      if (c.state !== 'succeeded') row.problems.push(`TileDB to COG: ${c.error}`);
      else {
        const m = oracle('tiledb-check', array, c.path);
        row.back.tiledb_py = m;
        if (!m.equal) row.problems.push(`COG from the array differs in ${m.different} values`);
      }
    } finally {
      sc2.stop();
      rmSync(join(WORK, 'tdb2'), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
    return row;
  });
  expect(problems).toEqual([]);
});
