// 2.1 sar group (SDP-2.1 FC-20, FC-21, FC-24, FC-25, FC-26) on the built file: BPF coordinate types,
// Assign CRS and the BPF writer read back by PDAL and the app; the CPHD phase-history view, panel,
// collection geometry and a subset read back by sarpy and the app; UAVSAR GRD with its annotation and an
// annotation alone; swath geolocation arrays; a Sentinel-1 SAFE folder as one product.
// Runs against the group build: GW_DIST (default dist-21-sar/gis-workbench.html).
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openApp, openFiles, DIST } from './helpers.js';

const HTML = DIST; // GW_DIST (helpers.js): a build folder or its .html
const FX = (...n) => resolve('fixtures/fx21/sar', ...n);
const TE = (...p) => join(process.env.TE_CORPUS ?? resolve('..', 'TE-corpus'), ...p);
const truth = JSON.parse(readFileSync(FX('sar_truth.json'), 'utf8'));
const GWTE = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te';
const haveTe = existsSync(`${GWTE}/python.exe`);
const env = { ...process.env, PATH: `${GWTE}/Library/bin;${GWTE};${GWTE}/Scripts;${process.env.PATH}`, PROJ_DATA: `${GWTE}/Library/share/proj`, GDAL_DATA: `${GWTE}/Library/share/gdal`, GDAL_DRIVER_PATH: `${GWTE}/Library/lib/gdalplugins` };
const PACKS = resolve(HTML, '..', 'packs');
const HDF5 = existsSync(PACKS) ? readdirSync(PACKS).find((n) => /^hdf5-.*\.gwpack$/.test(n)) : null;
const TMP = mkdtempSync(join(tmpdir(), 'gw21sar-'));
test.describe.configure({ timeout: 300000 });

/** A Blob the page makes, saved to a local file (tests only). */
async function pageBlob(frame, fn, arg, out) {
  const b64 = await frame.evaluate(async ([src, a]) => {
    // eslint-disable-next-line no-new-func
    const blob = await new Function('app', 'arg', `return (async () => { ${src} })()`)(window.gisworkbench, a);
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  }, [fn, arg]);
  writeFileSync(out, Buffer.from(b64, 'base64'));
  return out;
}

const clouds = (frame) => frame.evaluate(() => [...window.gisworkbench.pointClouds.values()].map((c) => ({ name: c.name, n: c.n, label: c.crs.label, local: !!c.crs.local, lat0: c.origin.lat0, lon0: c.origin.lon0, src: !!c.src })));

test('REQ-FMT-47 REQ-FMT-48 BPF: TCR converts to WGS 84, ENU/Cartesian open local and take a CRS; the writer is read by PDAL and the app', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file', { htmlPath: HTML });
  const log = await openFiles(frame, [FX('bpf-tcr-zlib.bpf'), FX('bpf-enu-none.bpf'), FX('bpf-cart-zlib.bpf'), FX('bpf-utm-zlib-byte.bpf')]);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  await frame.waitForFunction(() => window.gisworkbench.pointClouds.size === 4, null, { timeout: 60000 });
  let c = await clouds(frame);
  const tcr = c.find((x) => /tcr/.test(x.name));
  expect(tcr.label).toBe('EPSG:4326');
  expect(tcr.lat0).toBeCloseTo(truth.bpf.origin.lat, 3);
  expect(tcr.lon0).toBeCloseTo(truth.bpf.origin.lon, 3);
  expect(c.find((x) => /enu/.test(x.name)).local).toBe(true);
  expect(c.find((x) => /cart/.test(x.name))).toMatchObject({ local: true, src: true });
  expect(c.find((x) => /utm/.test(x.name)).label).toBe('EPSG:32611');
  const warn = log.find((r) => /enu/.test(r.file)).warnings.join(' ');
  expect(warn).toMatch(/local metric frame.*Assign CRS/);
  // Assign CRS: the Cartesian file holds UTM 11N numbers.
  await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const cart = [...app.pointClouds.values()].find((x) => /cart/.test(x.name));
    await app.pc.assignCrs(cart, { epsg: 32611 });
  });
  c = await clouds(frame);
  const placed = c.filter((x) => /cart/.test(x.name)).at(-1);
  expect(placed.label).toBe('EPSG:32611');
  expect(placed.lat0).toBeCloseTo(truth.bpf.origin.lat, 3);
  // The writer: UTM zlib and TCR none from the TCR cloud; PDAL reads both, the app reads them back.
  for (const [ct, cz, tag] of [[1, 'zlib', 'utm'], [2, 'none', 'tcr'], [3, 'zlib', 'enu']]) {
    const out = await pageBlob(frame, `const c = [...app.pointClouds.values()].find((x) => /tcr/.test(x.name)); const r = await app.pc.exportBpf(c, { coordType: arg[0], compression: arg[1] }); return new Blob([r.bytes]);`, [ct, cz], join(TMP, `w-${tag}.bpf`));
    if (haveTe && tag !== 'enu') {
      const s = JSON.parse(execFileSync(`${GWTE}/Library/bin/pdal.exe`, ['info', '--summary', out], { env, encoding: 'utf8' })).summary;
      expect(s.num_points).toBe(truth.bpf.n);
      if (tag === 'utm') {
        expect(s.bounds.minx).toBeGreaterThan(664000);
        expect(s.bounds.maxy).toBeLessThan(3998300);
      } else expect(s.srs.wkt ?? JSON.stringify(s.srs)).toMatch(/GEOCCS|4978|geocentric/i);
    }
    await openFiles(frame, [out]);
  }
  await frame.waitForFunction(() => window.gisworkbench.pointClouds.size >= 7, null, { timeout: 60000 });
  c = await clouds(frame);
  for (const tag of ['utm', 'tcr']) {
    const back = c.find((x) => x.name === `w-${tag}.bpf`);
    expect(back.n).toBe(truth.bpf.n);
    expect(back.lat0).toBeCloseTo(truth.bpf.origin.lat, 3);
  }
  expect(c.find((x) => x.name === 'w-enu.bpf').local).toBe(true);
  expect(logs).toEqual([]);
});

test('REQ-FMT-49 REQ-FMT-51 CPHD: phase-history view, panel, geometry; a subset sarpy reads and the app reopens', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file', { htmlPath: HTML });
  const log = await openFiles(frame, [FX('cphd-1.0.1-spot.cphd')]);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    const px = await app.pool.run('pixels', { handle: l.handle, x: 0, y: 0, w: 1, h: 1, bands: [2, 3] }, { affinity: l.affinity });
    const vl = app.store.all('vlayer').map((v) => ({ name: v.name, n: app.store.all('feature').filter((f) => f.vlayer === v.id).length }));
    app.commands.run('sar.cphd'); // a modeless panel: resolves when it closes
    await new Promise((res) => setTimeout(res, 300));
    const panel = document.querySelector('[data-id="dialog:cphd-panel"], [data-id="cphd-summary"]');
    const plots = [...document.querySelectorAll('.cphd-plot')].map((p) => p.dataset.plot);
    return { w: l.width, h: l.height, kind: l.info.sar.kind, fmt: l.info.format, model: l.modelName ?? null, iq: px.values.map((v) => v[0]), vl, panel: !!panel, plots, enabled: ['sar.cphdsubset'].map((c) => app.commands.enabled(c)) };
  });
  expect([r.w, r.h]).toEqual([truth.cphd.ns, truth.cphd.nv]);
  expect(r.kind).toBe('CPHD');
  expect(r.fmt).toMatch(/CPHD 1\.0\.1 phase history \(CI4, 1 channel\), channel VV/);
  expect(r.iq).toEqual(truth.cphd.first);
  expect(r.vl[0].name).toMatch(/collection geometry/);
  expect(r.vl[0].n).toBe(4); // image area, IARP, SRP, ARP track
  expect(r.panel).toBe(true);
  expect(r.plots).toEqual(expect.arrayContaining(['Time', 'Positions', 'Frequencies']));
  expect(r.enabled).toEqual([true]);
  const out = await pageBlob(frame, `const l = [...app.layers.values()][0]; return (await app.sar21.subset(l, { v0: 8, v1: 40, s0: 4, s1: 60 })).blob;`, null, join(TMP, 'subset.cphd'));
  if (haveTe) {
    const s = execFileSync(`${GWTE}/python.exe`, ['-I', '-c', 'import sys\nfrom sarpy.io.phase_history.converter import open_phase_history\nr = open_phase_history(sys.argv[1])\nb = r.read_signal_block()\nk = list(b)[0]\nprint(*b[k].shape)', out], { env, encoding: 'utf8' }).trim();
    expect(s).toBe('32 56');
  }
  await openFiles(frame, [out]);
  const back = await frame.evaluate(() => [...window.gisworkbench.layers.values()].filter((l) => l.info?.fileName === 'subset.cphd').map((l) => [l.width, l.height]));
  expect(back).toEqual([[56, 32]]);
  expect(logs).toEqual([]);
});

test('REQ-FMT-53 UAVSAR: GRD power and complex on the annotation grid, SLC in radar geometry, an annotation alone as the swath', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file', { htmlPath: HTML });
  const T = truth.uavsar;
  const log = await openFiles(frame, [FX(`${T.stem}_CX_01.ann`), FX(`${T.stem}HHHH_CX_01.grd`), FX(`${T.stem}HHVV_CX_01.grd`), FX(`${T.stem}HH_CX_01.slc`)]);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length === 3, null, { timeout: 60000 });
  const r = await frame.evaluate(() =>
    [...window.gisworkbench.layers.values()].map((l) => {
      const g = l.modelId ? l.groundAt(0.5, 0.5, 0) : null;
      return { name: l.info.fileName, w: l.width, h: l.height, fmt: l.info.format, model: l.modelName ?? null, lat: g?.lat, lon: g?.lon, sar: l.info.sar?.kind ?? null };
    }),
  );
  const grd = r.find((x) => /HHHH.*grd/.test(x.name));
  expect([grd.w, grd.h]).toEqual([T.grd.cols, T.grd.rows]);
  expect(grd.model).toMatch(/^Map \(EPSG:4326\)/);
  expect(grd.lat).toBeCloseTo(T.grd.lat, 6);
  expect(grd.lon).toBeCloseTo(T.grd.lon, 6);
  expect(r.find((x) => /HHVV/.test(x.name)).sar).toBe('UAVSAR');
  const slc = r.find((x) => /\.slc$/.test(x.name));
  expect([slc.w, slc.h]).toEqual([T.slc.cols, T.slc.rows]);
  expect(slc.model ?? 'none').toBe('none'); // radar geometry: no map model
  expect(slc.fmt).toMatch(/slant range/);
  // An annotation alone: the swath footprint with its products listed.
  const log2 = await openFiles(frame, [FX(`${T.stem}_CX_01.ann`)]);
  expect(log2.flatMap((x) => x.errors)).toEqual([]);
  const vl = await frame.evaluate(() => window.gisworkbench.store.all('vlayer').map((v) => v.name));
  expect(vl.some((n) => /UAVSAR swath/.test(n))).toBe(true);
  expect(logs).toEqual([]);
});

test('REQ-FMT-54 swath geolocation arrays: pixels at their array positions, across the antimeridian', async ({ page }) => {
  test.skip(!HDF5, 'no HDF5 data pack in the build');
  const { frame, logs } = await openApp(page, 'file', { htmlPath: HTML });
  const log = await openFiles(frame, [join(PACKS, HDF5), FX('swath-vegas.nc'), FX('swath-antimeridian.nc'), FX('swath-subsampled.nc')]);
  expect(log.flatMap((x) => x.errors)).toEqual([]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length === 3, null, { timeout: 120000 });
  const got = await frame.evaluate((cases) =>
    [...window.gisworkbench.layers.values()].map((l) => {
      const c = cases[l.info.fileName];
      return { name: l.info.fileName, model: l.modelName, probes: c.probes.map((p) => {
        const g = l.groundAt(p.x, p.y, 0);
        const q = l.imageAt?.(g.lat, g.lon, 0) ?? null;
        return { lat: g.lat, lon: g.lon, want: p.ll, back: q };
      }) };
    }), truth.swath.cases);
  for (const l of got) {
    expect(l.model, l.name).toMatch(/^Geolocation arrays/);
    for (const p of l.probes) {
      const tol = /subsampled/.test(l.name) ? 1e-3 : 1e-5;
      expect(Math.abs(p.lat - p.want[0]), l.name).toBeLessThan(tol);
      expect(Math.abs(((p.lon - p.want[1] + 540) % 360) - 180), l.name).toBeLessThan(tol);
    }
  }
  expect(logs).toEqual([]);
});

test('REQ-FMT-55 a Sentinel-1 SAFE folder opens as one product: swaths × polarisations, bursts, grid model, calibrated bands', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file', { htmlPath: HTML });
  const dir = FX(truth.safe.dir);
  const all = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : all.push(join(d, e.name));
  };
  walk(dir);
  const log = await openFiles(frame, all);
  expect(log.flatMap((x) => x.errors)).toEqual([]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex || l.rec?.visible === false).length === 4, null, { timeout: 120000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()];
    const l = ls.find((x) => /iw1-slc-vv/.test(x.info.fileName));
    const px = await app.pool.run('pixels', { handle: l.handle, x: 5, y: 5, w: 1, h: 1, bands: [0, 6] }, { affinity: l.affinity });
    return {
      n: ls.length,
      fmts: ls.map((x) => x.info.format).sort(),
      models: [...new Set(ls.map((x) => x.modelName))],
      visible: ls.filter((x) => x.rec.visible !== false).length,
      vl: app.store.all('vlayer').map((v) => ({ name: v.name, n: app.store.all('feature').filter((f) => f.vlayer === v.id).length })),
      amp: px.values[0][0],
      s0: px.values[1][0],
      rows: app.sar21.rows(l).map((x) => x[0]),
      rad: l.info.sar.radiometry?.note,
      g: l.groundAt(0.5, 0.5, 0),
    };
  });
  expect(r.n).toBe(4);
  expect(r.fmts[0]).toMatch(/Sentinel-1 S1A IW SLC IW1 VH \(.*SAFE\)/);
  expect(r.models).toEqual([expect.stringMatching(/^Annotation geolocation grid \(3 × 4 points\)/)]);
  expect(r.visible).toBe(2); // one polarisation per swath shown
  expect(r.vl.filter((v) => /bursts/.test(v.name)).map((v) => v.n), JSON.stringify(r.vl)).toEqual([2, 2]); // two bursts per swath
  expect(r.amp).toBeCloseTo(Math.hypot(100 + 5 + 50, 5), 3);
  expect(Number.isFinite(r.s0)).toBe(true);
  expect(r.rad).toMatch(/calibration look-up tables, thermal noise removed/);
  expect(r.g.lat).toBeCloseTo(36.3, 6);
  expect(r.rows).toContain('Bursts');
  // The support files did not open as layers of their own.
  expect(log.filter((x) => /\.(xsd|xml|kml|png|html)$/i.test(x.file))).toEqual([]);
  expect(logs).toEqual([]);
});

test('REQ-FMT-49 corpus CPHD (GDAL autotest 1.1.0) opens as a phase history', async ({ page }) => {
  const f = TE('sar-cphd-gdal-autotest', 'test.cphd');
  test.skip(!existsSync(f), 'T&E corpus absent');
  const { frame, logs } = await openApp(page, 'file', { htmlPath: HTML });
  const log = await openFiles(frame, [f]);
  expect(log.flatMap((x) => x.errors)).toEqual([]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  const fmt = await frame.evaluate(() => [...window.gisworkbench.layers.values()][0].info.format);
  expect(fmt).toMatch(/CPHD 1\.1\.0 phase history/);
  expect(logs).toEqual([]);
});
