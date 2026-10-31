// TE-C53 writer round trips (2.0.4 campaign): for the stratified corpus (3 files per format key), every
// writer that accepts what the file became writes it — image → COG and the five chip products; DEM →
// GeoTIFF, DTED 2 and SRTM HGT; point cloud → LAS and LAZ; vector layer → GeoJSON, Shapefile, KML,
// KMZ, GeoPackage, CSV, GeoParquet and FlatGeobuf. Each output is described by the independent readers
// (oracles/roundtrip.py: GDAL, OGR, laspy), checked against the source as the app read it (size,
// bands, feature and point counts), and opened again in the app, which must read it back the same.
//
//   TE_DIST=dist-cx3/gis-workbench.html TE_RUN=cx-rt [TE_ONLY=<regex>]
//   npx playwright test -c playwright.campaign.config.js c53-roundtrip --project=chrome
import { test, expect } from '@playwright/test';
import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ASCII_CRS, openFiles, settledAny } from './helpers.js';
import { cases, EXPECT, refusedKeys, ROBUST, stratify } from './cases.js';
import { session, recordWriter, outDir } from './cross-lib.js';
import { createHash } from 'node:crypto';
import { REPO } from '../../build/campaign/corpus-lib.mjs';

const RUN = process.env.TE_RUN ?? 'cx-rt';
const OUT = outDir(RUN);
const ONLY = process.env.TE_ONLY ? new RegExp(process.env.TE_ONLY) : null;
const ENV = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te';
const PY = `${ENV}/python.exe`;
// What micromamba activation would set: GDAL's and PROJ's data folders (NITF TRE specs, EPSG database).
// Library/bin on PATH: numpy's MKL LAPACK loads its runtime DLLs through PATH; without activation
// np.linalg died with 0xC06D007F (ICHIPB fit). GeoParquet output is checked by the app's reread (the
// env's GDAL Parquet plugin needs duckdb.dll, which is absent).
const PY_ENV = { ...process.env, PATH: `${ENV}/Library/bin;${process.env.PATH}`, GDAL_DATA: `${ENV}/Library/share/gdal`, PROJ_DATA: `${ENV}/Library/share/proj`, PROJ_LIB: `${ENV}/Library/share/proj` };
const MAX_OUT = 160e6; // bytes a writer may hand back through the page in one go

const chosen = stratify(cases).filter((c) => !ONLY || ONLY.test(`${c.it.id}/${c.f.name}`));

/** Every writer the opened data accepts, run in the page; outputs come back as base64 with the source facts. */
const WRITE = async (maxOut) => {
  const a = window.gisworkbench;
  const out = [];
  // All outputs come back in one call: past ~200 MB together the base64 passed Node's 512 MB string
  // limit and the test died (CX-H23: Microsoft building footprints, five vector formats).
  let total = 0;
  const b64 = async (blob) => {
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const put = async (writer, src, fn) => {
    const t0 = performance.now();
    try {
      const r = await fn();
      // A writer that saves through saveBlob downloads its file; the spec pairs it with this entry.
      if (!r) return out.push({ writer, src, viaDownload: true });
      for (const [name, blob] of r) {
        if (blob.size > maxOut || total + blob.size > 200e6) {
          out.push({ writer, src, name, skipped: `${blob.size} bytes${blob.size > maxOut ? '' : ' (over the 200 MB the page hands back per file)'}` });
          continue;
        }
        total += blob.size;
        out.push({ writer, src, name, bytes: blob.size, b64: await b64(blob), ms: Math.round(performance.now() - t0) });
      }
    } catch (e) {
      // An empty layer (a balloon-only KMZ, an empty feature class, skipped multipatch) is refused by
      // name since CX-058: nothing to round-trip.
      if (src?.features === 0 && /no features to save/.test(String(e?.message))) return out.push({ writer, src, skipped: 'empty layer (refused by name)' });
      out.push({ writer, src, error: String(e?.message ?? e) });
    }
  };
  const layers = [...a.layers.values()].filter((l) => !l.error && l.handle);
  for (const l of layers.slice(0, 2)) {
    // A SAR COG holds the displayed band(s), named in its toast (batch 7): `shown` is that count (CX-H23).
    const src = { kind: l.kind, name: l.rec?.name, w: l.width, h: l.height, bands: l.bands, model: l.modelName ?? null, sar: !!l.info?.sar, shown: l.chain?.bands?.length ?? null };
    a.store.transact('TE active layer', (tx) => tx.set(a.activePane().id, 'activeLayer', l.id));
    // COG: full resolution, all bands (needs the samples in memory: very large images give way).
    // (saveBlob downloads it: the spec collects the file from the download event.)
    if (l.width * l.height * l.bands <= 3e8) await put('cnv.cog', src, async () => (await a.convertToCog(l.id), null));
    // Chips: the five products of one 512 × 512 chip of the view (the NITF needs a sensor model).
    try {
      a.activePane().fitWhole?.();
      const chip = await a.makeChip({ width: 512, height: 512 });
      for (const fmt of ['png', 'jpeg', 'tif-display', 'tif-source', 'nitf-source']) {
        if (fmt === 'nitf-source' && !l.modelId) continue;
        await put(`chip.${fmt}`, { ...src, chip: 512 }, async () => {
          const r = await a.encodeProduct(chip, fmt);
          return [[r.name, r.blob]];
        });
      }
    } catch (e) {
      out.push({ writer: 'chip', src, error: String(e?.message ?? e) });
    }
    // DEM writers.
    if (l.kind === 'dem') {
      await a.useAsTerrain(l, 'hae');
      const d = a.terrain.entry(l.id);
      if (d) {
        const g = d.grid;
        const dsrc = { ...src, gridW: g.width, gridH: g.height };
        await put('dem.save.tif', dsrc, async () => [[`${l.rec.name}_dem.tif`, new Blob([await a.demGeoTiff(d)])]]);
        await put('dem.save.dt2', dsrc, async () => a.demDted(2, d).slice(0, 1).map((c) => [c.name, new Blob([c.bytes])]));
        await put('dem.save.hgt', dsrc, async () => a.demHgt(3, d).slice(0, 1).map((c) => [c.name, new Blob([c.bytes])]));
      }
    }
  }
  // Point clouds.
  const c = a.pc?.cloudOf?.();
  if (c) {
    const src = { kind: 'pointcloud', name: c.name, points: c.n };
    await put('pc.export.las', src, async () => {
      const r = await a.pc.exportLas(c, { compress: false });
      return [[r.name, new Blob([r.bytes])]];
    });
    await put('pc.export.laz', src, async () => {
      const r = await a.pc.exportLas(c, { compress: true });
      return [[r.name, new Blob([r.bytes])]];
    });
  }
  // Vector layers.
  for (const v of a.store.all('vlayer').slice(0, 2)) {
    const fs = a.store.all('feature').filter((f) => f.vlayer === v.id);
    const n = fs.length;
    // Features without a finite position: KML writes them without geometry, so its readers skip them.
    const noPos = fs.filter((f) => !Array.from(f.geom?.xyz ?? []).every(Number.isFinite)).length;
    const src = { kind: 'vector', name: v.name, features: n, noPos };
    for (const fmt of ['geojson', 'shp', 'kml', 'kmz', 'csv']) await put(`ext.saveas.${fmt}`, src, async () => {
      const r = await a.encodeLayer(v.id, fmt);
      return [[r.name, r.blob]];
    });
    for (const mgcp of [false, true]) await put(`ext.saveas.gpkg${mgcp ? '-mgcp' : ''}`, src, async () => {
      const r = await a.attribution.gpkgBytes([v.id], { mgcp });
      return [[`${(v.name || 'layer').replace(/[^\w.-]+/g, '_')}${mgcp ? '_mgcp' : ''}.gpkg`, new Blob([r.bytes])]];
    });
    for (const fmt of ['geoparquet', 'flatgeobuf']) await put(`cnv.${fmt}`, src, async () => {
      const r = await a.encodeVector(v.id, fmt);
      return [[r.name, r.blob]];
    });
  }
  return out;
};

test.describe.configure({ mode: 'parallel' });
for (const { it, f, files } of chosen) {
  const name = f.name.split('/').pop();
  const key = `${it.id}/${f.name}`;
  test(`TE-C53 REQ-CNV-01 REQ-CNV-02 REQ-PRD-03 REQ-DEM-16 ${key}`, async ({ page }, info) => {
    test.skip(!files.every((p) => p && existsSync(p)), 'not on disk');
    test.skip(!!(EXPECT[name]?.refuse || refusedKeys(it, f).length || ROBUST(it)), 'refused by design (c01)');
    const bytes = files.reduce((t, p) => t + statSync(p).size, 0);
    test.setTimeout(bytes > 200e6 ? 3600_000 : 900_000);
    // A short folder per file: the key in full put outputs past Windows' 260-character path limit
    // and their reopen failed "could not be found" (CX-H08).
    const dir = join(REPO, 'reports/campaign/out', `${RUN}-files`, `${key.replace(/[^\w.-]+/g, '_').slice(0, 40)}-${createHash('sha1').update(key).digest('hex').slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(OUT, { recursive: true });
    const rec = { spec: 'c53-roundtrip', project: info.project.name, key, item: it.id, file: name, outputs: [] };
    const save = recordWriter(join(OUT, `c53-${info.project.name}-${key.replace(/[^\w.-]+/g, '_')}.json`), rec);
    const s = await session(page, { files, epsg: ASCII_CRS[name] ?? null, big: bytes > 200e6, setupSteps: ['ai-mock'] });
    // Downloads (the COG goes through saveBlob) are captured too.
    const downloads = [];
    page.on('download', async (d) => {
      const p = join(dir, d.suggestedFilename());
      await d.saveAs(p).catch(() => {});
      downloads.push(p);
    });
    const o = await s.open();
    rec.open = { ok: o.ok, errors: o.errors, layers: o.layers.length };
    if (!o.ok && !o.layers.length) {
      rec.skipped = 'did not open';
      save();
      return;
    }
    const outs = await s.frame.evaluate(WRITE, MAX_OUT);
    await page.waitForTimeout(500);
    for (const x of outs) {
      if (x.b64) {
        const p = join(dir, x.name);
        writeFileSync(p, Buffer.from(x.b64, 'base64'));
        delete x.b64;
        x.path = p;
      }
    }
    // Downloads: the COG of each image layer, in order.
    const viaDl = outs.filter((x) => x.viaDownload);
    downloads.forEach((p, i) => Object.assign(viaDl[i] ?? outs[outs.push({ writer: 'download' }) - 1], { name: p.split(/[\\/]/).pop(), path: p, bytes: existsSync(p) ? statSync(p).size : 0 }));
    const written = outs.filter((x) => x.path);
    // Independent description of every output.
    const py = spawnSync(PY, ['-I', 'build/campaign/oracles/roundtrip.py'], { input: JSON.stringify(written.map((x) => x.path)), maxBuffer: 1 << 28, encoding: 'utf8', env: PY_ENV });
    rec.oracleStatus = py.status;
    if (py.status !== 0) rec.oracleStderr = String(py.stderr).slice(-2000);
    const desc = py.status === 0 ? JSON.parse(py.stdout) : {};
    // Read back by the app: each output alone in a new project.
    for (const x of written) {
      const d = desc[x.path] ?? { error: py.stderr?.slice(0, 300) || 'no description' };
      x.oracle = d.error ? { error: d.error } : summary(d);
      x.checks = check(x, d);
      await s.frame.evaluate(() => {
        const a = window.gisworkbench;
        a.dirty = false;
        for (const mp of [...a.desktop.multiports]) a.desktop.removeMultiport(mp);
        a.desktop.addMultiport(a.newProject());
        a.importLog.length = 0;
      });
      const log = await openFiles(s.frame, [x.path]).catch((e) => [{ errors: [String(e.message)] }]);
      const ok = await settledAny(s.frame, 0, 60_000);
      x.reopen = { errors: log.flatMap((r) => r.errors ?? []), settled: ok, ...(await s.frame.evaluate(() => {
        const a = window.gisworkbench;
        const l = [...a.layers.values()][0];
        return { w: l?.width ?? null, h: l?.height ?? null, bands: l?.bands ?? null, features: a.store.all('feature').length, points: a.pc?.cloudOf?.()?.n ?? null };
      })) };
      x.checks.push(...reopenChecks(x));
    }
    rec.outputs = outs;
    rec.logs = s.logs.slice(0, 20);
    save();
    // A source chip over the product limit is refused by name (285-band EMIT at full resolution, batch 7).
    const named = (x) => /samples are more than a product takes/.test(x.error ?? '');
    const bad = outs.flatMap((x) => [...(x.error && !named(x) ? [`${x.writer}: ${x.error}`] : []), ...(x.checks ?? []).filter((c) => !c.ok).map((c) => `${x.writer} ${x.name}: ${c.what}: ${c.detail}`)]);
    expect(bad, `${key}: every writer's output reads back`).toEqual([]);
  });
}

function summary(d) {
  if (d.kind === 'raster') return { kind: 'raster', w: d.width, h: d.height, bands: d.bands, dtype: d.dtype ?? d.dataType, epsg: d.epsg ?? null, driver: d.driver };
  if (d.kind === 'vector') return { kind: 'vector', layers: (d.layers ?? []).map((l) => ({ name: l.name, features: l.features ?? l.featureCount, geom: l.geometryType ?? l.geom })) };
  if (d.kind === 'lidar') return { kind: 'lidar', points: d.points, pdrf: d.pdrf, version: d.version };
  return d;
}

const near = (a, b, tol = 0) => Math.abs(a - b) <= tol;

/** Output vs the source as the app read it, by writer. */
function check(x, d) {
  const out = [];
  const add = (what, ok, detail = '') => out.push({ what, ok: !!ok, detail });
  // No independent GeoParquet reader on this machine (GDAL's plugin is unusable, no pyarrow): the
  // app's reread below and the unit test against hyparquet carry that format.
  if (d.error && x.writer === 'cnv.geoparquet') return [{ what: 'independent reader (none available)', ok: true, detail: d.error.slice(0, 120) }];
  if (d.error) return [{ what: 'independent reader opens it', ok: false, detail: d.error }];
  const s = x.src ?? {};
  if (x.writer === 'cnv.cog' || x.writer === 'chip.tif-source' || x.writer === 'chip.nitf-source') {
    if (x.writer === 'cnv.cog') add('COG size = source', d.width === s.w && d.height === s.h, `${d.width}×${d.height} vs ${s.w}×${s.h}`);
    const want = s.sar && s.bands > 3 && x.writer === 'cnv.cog' ? s.shown : s.bands;
    add('bands = source', d.bands === want || (s.bands > 3 && x.writer !== 'cnv.cog' && d.bands >= 1), `${d.bands} vs ${want}${want !== s.bands ? ` (SAR: displayed of ${s.bands})` : ''}`);
  }
  if (/^chip\./.test(x.writer)) add('chip opens with pixels', d.width > 0 && d.height > 0, `${d.width}×${d.height}`);
  if (x.writer === 'dem.save.tif') add('grid size', d.width === s.gridW && d.height === s.gridH, `${d.width}×${d.height} vs ${s.gridW}×${s.gridH}`);
  if (x.writer === 'dem.save.dt2') add('DTED 2 rows', d.height === 3601, `${d.width}×${d.height}`);
  if (x.writer === 'dem.save.hgt') add('HGT 3″ tile', d.width === 1201 && d.height === 1201, `${d.width}×${d.height}`);
  if (/^pc\.export/.test(x.writer)) add('point count', d.points === s.points, `${d.points} vs ${s.points}`);
  if (/^(ext\.saveas|cnv\.(geoparquet|flatgeobuf))/.test(x.writer)) {
    const n = (d.layers ?? []).reduce((t, l) => t + (l.features ?? l.featureCount ?? 0), 0);
    // KML/KMZ put each geometry family in a folder; a shapefile set has one layer per family.
    add('feature count', n === s.features || (x.writer.endsWith('csv') && n >= s.features), `${n} vs ${s.features}`);
  }
  return out;
}

function reopenChecks(x) {
  const r = x.reopen;
  const s = x.src ?? {};
  const out = [{ what: 'the app opens its own output', ok: !r.errors.length, detail: r.errors.join(' ').slice(0, 200) }];
  const bandsWant = s.sar && s.bands > 3 ? s.shown : s.bands;
  if (x.writer === 'cnv.cog') out.push({ what: 'reopened COG size', ok: r.w === s.w && r.h === s.h && r.bands === bandsWant, detail: `${r.w}×${r.h}×${r.bands} vs ${s.w}×${s.h}×${bandsWant}` });
  if (/^pc\.export/.test(x.writer)) out.push({ what: 'reopened point count', ok: r.points === s.points, detail: `${r.points} vs ${s.points}` });
  if (/^(ext\.saveas\.(geojson|gpkg|kml|kmz)|cnv\.(geoparquet|flatgeobuf))$/.test(x.writer)) out.push({ what: 'reopened features', ok: r.features === s.features || (/kml|kmz/.test(x.writer) && r.features === s.features - (s.noPos ?? 0)), detail: `${r.features} vs ${s.features}${s.noPos ? ` (${s.noPos} without a position)` : ''}` });
  return out;
}
