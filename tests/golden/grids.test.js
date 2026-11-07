// REQ-GAP-16 golden tests: the shipped `geod` bundle against PROJ 9.9 `cct` (gw-te conda env)
// on the PROJ-data grids of the 2.4 grid packs — hgridshift (NTv2 conversions, OSTN15, BETA2007,
// GDA94→GDA2020), gridshift (NADCON5 biquadratic, 2D and 3D) and vgridshift (GEOID18, OSGM15,
// AUSGeoid2020, CGG2013, EGM2008 2.5′), forward and inverse, with interior points, points on and
// next to the grid edges, nested sub-grid boundaries, nodata cells and points outside. The same
// grids are also read as NTv2 (.gsb) and GTX after gdal_translate. Then the time-dependent frame
// transformations (ITRF, WGS 84 realisations, NAD83(2011), GDA2020, ETRF) against the pipeline
// PROJ itself picks (projinfo), at several epochs. Tolerance: 1 mm horizontally and vertically.
//
// Needs: the grids in .cache/packs-src/grids (node build/packs.mjs --fetch) and the gw-te env;
// the WASM from the built HTML (TE_DIST) or GEOD_WASM. Skips cleanly when any is missing.
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { GeodBundle } from '../../app/src/wasm/geod.js';
import { built, blockBytes } from './wasm.js';

const ENV = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te';
const BIN = `${ENV}/Library/bin`;
const GRIDS = resolve('.cache/packs-src/grids');
const haveProj = existsSync(`${BIN}/cct.exe`) && existsSync(`${BIN}/projinfo.exe`);
const wasmBytes = () => {
  if (process.env.GEOD_WASM && existsSync(process.env.GEOD_WASM)) return readFileSync(process.env.GEOD_WASM);
  if (!built) return null;
  try {
    return blockBytes('wasm-geod');
  } catch {
    return null;
  }
};
const WASM = wasmBytes();
const ready = !!WASM && haveProj && existsSync(GRIDS);
const TOL = 1e-3; // metres
const M_PER_DEG = 111_320;

function projEnv(extra = []) {
  return { ...process.env, PROJ_DATA: [`${ENV}/Library/share/proj`, GRIDS, ...extra].join(';'), PROJ_NETWORK: 'OFF' };
}

/** Run cct; one result per input row ([x, y, z] or null where PROJ reports an error). */
function cct(args, rows, extraDirs = [], digits = 12) {
  const input = rows.map((r) => r.join(' ')).join('\n') + '\n';
  const out = execFileSync(`${BIN}/cct.exe`, ['-d', String(digits), ...args], { input, env: projEnv(extraDirs), maxBuffer: 256 << 20, encoding: 'utf8' });
  const res = [];
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (l.startsWith('#')) {
      res.push(null);
      if (lines[i + 1]?.startsWith(' (')) i++;
      continue;
    }
    const v = l.trim().split(/\s+/).map(Number);
    res.push(v.slice(0, 3).some((x) => !Number.isFinite(x)) ? null : v.slice(0, 3));
  }
  expect(res.length).toBe(rows.length);
  return res;
}

const PIPE = {
  hgridshift: (g) => ['+proj=pipeline', '+step', '+proj=unitconvert', '+xy_in=deg', '+xy_out=rad', '+step', '+proj=hgridshift', `+grids=${g}`, '+step', '+proj=unitconvert', '+xy_in=rad', '+xy_out=deg'],
  gridshift: (g) => ['+proj=pipeline', '+step', '+proj=unitconvert', '+xy_in=deg', '+xy_out=rad', '+step', '+proj=gridshift', `+grids=${g}`, '+step', '+proj=unitconvert', '+xy_in=rad', '+xy_out=deg'],
  // h → H: PROJ's EPSG pipelines use +inv +proj=vgridshift +multiplier=1.
  vgridshift: (g) => ['+proj=pipeline', '+step', '+proj=unitconvert', '+xy_in=deg', '+xy_out=rad', '+step', '+inv', '+proj=vgridshift', `+grids=${g}`, '+multiplier=1', '+step', '+proj=unitconvert', '+xy_in=rad', '+xy_out=deg'],
};
const ROLE = { hgridshift: 'horizontal', gridshift: 'generic', vgridshift: 'vertical' };

// A seeded generator, so failures reproduce.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Test points for a grid set: interior, nodes, edges (inside and just outside), sub-grid edges, far outside. */
function pointsFor(info, n, seed, extra = []) {
  const r = rng(seed);
  const pts = [];
  const g0 = info.grids[0];
  const all = info.grids;
  const pick = (g, u, v) => [g.west + u * (g.east - g.west), g.south + v * (g.north - g.south)];
  for (let i = 0; i < n; i++) {
    const g = all[i % Math.min(all.length, 40)];
    pts.push(pick(g, r(), r()));
  }
  for (const g of all.slice(0, 40)) {
    // Corners and edges 1e-9° inside (closer than that, cct's text parsing decides by one ulp),
    // just outside within PROJ's 1e-5-cell tolerance, and half a cell outside.
    const e = 1e-9;
    pts.push([g.west + e, g.south + e], [g.east - e, g.north - e], [g.west + e, g.north - e], [g.east - e, g.south + e]);
    pts.push([g.west + 3 * g.resX, g.south + 2 * g.resY]);
    for (let k = 0; k < 6; k++) {
      const t = r();
      pts.push(pick(g, t, 0).map((v, j) => (j === 1 ? v + e : v)), pick(g, t, 1).map((v, j) => (j === 1 ? v - e : v)), pick(g, 0, t).map((v, j) => (j === 0 ? v + e : v)), pick(g, 1, t).map((v, j) => (j === 0 ? v - e : v)));
      pts.push([g.west - 0.5 * g.resX, g.south + t * (g.north - g.south)], [g.east + 0.5 * g.resX, g.south + t * (g.north - g.south)], [g.west + t * (g.east - g.west), g.north + 0.5 * g.resY]);
      // within PROJ's 1e-5-cell edge tolerance
      pts.push([g.west - 2e-6 * g.resX, g.south + t * (g.north - g.south)], [g.east + 2e-6 * g.resX, g.south + t * (g.north - g.south)]);
    }
  }
  pts.push([g0.west - 30, g0.south - 20], [g0.east + 25, g0.north + 5]);
  return [...pts, ...extra].map(([x, y]) => [x, Math.max(-89.999, Math.min(89.999, y)), 100 * r() - 20]);
}

/** Nodes next to nodata (cells with 1–3 nodata corners and all-nodata cells), read with GDAL. */
function nodataCells(file, max = 80) {
  const py = `
import sys, numpy as np
from osgeo import gdal
ds = gdal.Open(sys.argv[1]); b = ds.GetRasterBand(1); nd = b.GetNoDataValue()
a = b.ReadAsArray().astype('float64'); gt = ds.GetGeoTransform()
if nd is None: sys.exit(0)
m = (a == nd)
c = m[:-1,:-1].astype(int) + m[1:,:-1] + m[:-1,1:] + m[1:,1:]
out = []
rs = np.random.RandomState(3)
for want in (1, 2, 3, 4):
    ij = np.argwhere(c == want)
    if len(ij) == 0: continue
    for k in rs.choice(len(ij), min(len(ij), ${max} // 4), replace=False):
        i, j = ij[k]
        # cell centre between nodes (j, i) and (j+1, i+1); GDAL geotransform is pixel-is-area here
        x = gt[0] + (j + 1.0 + rs.rand()) * gt[1]; y = gt[3] + (i + 1.0 + rs.rand()) * gt[5]
        out.append('%.12f %.12f' % (x - 0.5 * gt[1], y - 0.5 * gt[5]))
print('\\n'.join(out))
`;
  const out = execFileSync(`${ENV}/python.exe`, ['-I', '-c', py, file], { encoding: 'utf8', env: projEnv() });
  return out.split(/\r?\n/).filter(Boolean).map((l) => l.split(' ').map(Number));
}

/** Python (GDAL): GeoTIFF horizontal grid (every IFD) → NTv2 .gsb: rows south → north, columns east → west, longitude positive west. */
const NTV2_WRITER = String.raw`
import sys, struct
from osgeo import gdal
gdal.UseExceptions()
src, dst = sys.argv[1], sys.argv[2]
ds = gdal.Open(src)
subs = [s[0] for s in (ds.GetSubDatasets() or [])] or [src]
def rec(k, v): return k.ljust(8).encode()[:8] + v
def i4(v): return struct.pack('<i', v) + bytes(4)
def f8(v): return struct.pack('<d', v)
def s8(v): return v.ljust(8).encode()[:8]
out = [rec('NUM_OREC', i4(11)), rec('NUM_SREC', i4(11)), rec('NUM_FILE', i4(len(subs))), rec('GS_TYPE', s8('SECONDS')),
       rec('VERSION', s8('NTv2.0')), rec('SYSTEM_F', s8('A')), rec('SYSTEM_T', s8('B')),
       rec('MAJOR_F', f8(6378206.4)), rec('MINOR_F', f8(6356583.8)), rec('MAJOR_T', f8(6378137.0)), rec('MINOR_T', f8(6356752.314))]
for k, s in enumerate(subs):
    d = gdal.Open(s)
    md = d.GetMetadata()
    name = md.get('grid_name', 'G%d' % k)
    parent = md.get('parent_grid_name', 'NONE')
    gt = d.GetGeoTransform(); w, h = d.RasterXSize, d.RasterYSize
    west = gt[0] + 0.5 * gt[1]; north = gt[3] + 0.5 * gt[5]
    east = west + gt[1] * (w - 1); south = north + gt[5] * (h - 1)
    lat = d.GetRasterBand(1).ReadAsArray(); lon = d.GetRasterBand(2).ReadAsArray()
    out += [rec('SUB_NAME', s8(name)), rec('PARENT', s8(parent)), rec('CREATED', s8('')), rec('UPDATED', s8('')),
            rec('S_LAT', f8(south * 3600)), rec('N_LAT', f8(north * 3600)), rec('E_LONG', f8(-east * 3600)), rec('W_LONG', f8(-west * 3600)),
            rec('LAT_INC', f8(-gt[5] * 3600)), rec('LONG_INC', f8(gt[1] * 3600)), rec('GS_COUNT', i4(w * h))]
    body = bytearray()
    for r in range(h):
        row = h - 1 - r
        for c in range(w):
            col = w - 1 - c
            body += struct.pack('<ffff', float(lat[row, col]), -float(lon[row, col]), 0.0, 0.0)
    out.append(bytes(body))
out.append(rec('END', bytes(8)))
open(dst, 'wb').write(b''.join(out))
`;

const CASES = [
  { file: 'de_adv_BETA2007.tif', op: 'hgridshift' },
  { file: 'uk_os_OSTN15_NTv2_OSGBtoETRS.tif', op: 'hgridshift' },
  { file: 'ca_nrc_ntv2_0.tif', op: 'hgridshift', n: 3000 },
  { file: 'au_icsm_GDA94_GDA2020_conformal.tif', op: 'hgridshift' },
  { file: 'us_noaa_nadcon5_nad27_nad83_1986_conus.tif', op: 'gridshift' },
  { file: 'us_noaa_nadcon5_nad83_1986_nad83_harn_conus.tif', op: 'gridshift' },
  { file: 'us_noaa_nadcon5_nad83_harn_nad83_fbn_conus.tif', op: 'gridshift' },
  { file: 'us_noaa_nadcon5_nad83_fbn_nad83_2007_conus.tif', op: 'gridshift' },
  { file: 'us_noaa_nadcon5_nad83_2007_nad83_2011_conus.tif', op: 'gridshift' },
  { file: 'us_noaa_g2018u0.tif', op: 'vgridshift' },
  { file: 'uk_os_OSGM15_GB.tif', op: 'vgridshift', nodata: true },
  { file: 'au_ga_AUSGeoid2020_20180201.tif', op: 'vgridshift', nodata: true },
  { file: 'ca_nrc_CGG2013an83.tif', op: 'vgridshift' },
  { file: 'us_nga_egm08_25.tif', op: 'vgridshift', n: 4000 },
];

const REPORT = { grids: [], frames: [] };

function compare(ours, theirs, pts, label) {
  let maxH = 0;
  let maxV = 0;
  let ok = 0;
  let outside = 0;
  const mismatch = [];
  for (let i = 0; i < pts.length; i++) {
    const a = ours[i];
    const b = theirs[i];
    const aBad = !a || a.some((v) => !Number.isFinite(v));
    if (aBad || !b) {
      if (aBad !== !b) mismatch.push({ i, pt: pts[i], ours: a, proj: b });
      else outside++;
      continue;
    }
    const dy = (a[1] - b[1]) * M_PER_DEG;
    const dx = (((a[0] - b[0] + 540) % 360) - 180) * M_PER_DEG * Math.cos((b[1] * Math.PI) / 180);
    maxH = Math.max(maxH, Math.hypot(dx, dy));
    maxV = Math.max(maxV, Math.abs(a[2] - b[2]));
    ok++;
  }
  return { label, points: pts.length, compared: ok, outsideBoth: outside, mismatches: mismatch.length, firstMismatch: mismatch.slice(0, 3), maxHorizontalM: maxH, maxVerticalM: maxV };
}

describe.skipIf(!ready)('REQ-GAP-16 grids: geod bundle vs PROJ cct', () => {
  let geod;
  beforeAll(() => {
    geod = new GeodBundle(new WebAssembly.Module(WASM));
  });

  for (const c of CASES) {
    const path = join(GRIDS, c.file);
    it.skipIf(!existsSync(path))(`${c.op} ${c.file}: forward and inverse within 1 mm, same cells outside`, () => {
      const id = geod.open(readFileSync(path), ROLE[c.op], c.file, { cacheMb: 128 });
      try {
        const info = geod.info(id);
        const extra = c.nodata ? nodataCells(path) : [];
        if (c.nodata) expect(extra.length).toBeGreaterThan(10);
        const pts = pointsFor(info, c.n ?? 1500, 17 + c.file.length, extra);
        for (const inverse of [false, true]) {
          // vgridshift: the PROJ pipeline is "+inv +proj=vgridshift +multiplier=1" (h → H = h − N),
          // which is our inverse with multiplier 1; cct -I on it (H → h) is our forward.
          const vertical = c.op === 'vgridshift';
          const ours = geod.apply(c.op, [id], pts, vertical ? { inverse: !inverse, multiplier: 1 } : { inverse }).pts;
          const theirs = cct(inverse ? ['-I', ...PIPE[c.op](c.file)] : PIPE[c.op](c.file), pts);
          const r = compare(ours, theirs, pts, `${c.file} ${c.op}${inverse ? ' inverse' : ''}`);
          r.grids = info.grids.length;
          REPORT.grids.push(r);
          expect(r.mismatches, JSON.stringify(r.firstMismatch)).toBe(0);
          expect(r.compared).toBeGreaterThan(pts.length / (c.nodata ? 10 : 3));
          expect(r.maxHorizontalM).toBeLessThanOrEqual(TOL);
          expect(r.maxVerticalM).toBeLessThanOrEqual(TOL);
        }
      } finally {
        geod.close(id);
      }
    }, 300_000);
  }

  it.skipIf(!existsSync(join(GRIDS, 'de_adv_BETA2007.tif')))('NTv2 (.gsb) and GTX files converted by GDAL agree with PROJ reading the same files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-geod-'));
    // This GDAL build reads NTv2 but cannot write it: the .gsb files (with every nested
    // sub-grid) are written from the GeoTIFF bands in Python; GTX through gdal_translate.
    execFileSync(`${ENV}/python.exe`, ['-I', '-c', NTV2_WRITER, join(GRIDS, 'de_adv_BETA2007.tif'), join(dir, 'beta.gsb')], { env: projEnv() });
    execFileSync(`${ENV}/python.exe`, ['-I', '-c', NTV2_WRITER, join(GRIDS, 'ca_nrc_ntv2_0.tif'), join(dir, 'ntv2_0.gsb')], { env: projEnv() });
    execFileSync(`${BIN}/gdal_translate.exe`, ['-q', '-of', 'GTX', join(GRIDS, 'uk_os_OSGM15_GB.tif'), join(dir, 'osgm15.gtx')], { env: projEnv(), stdio: 'pipe' });
    for (const [f, op] of [['beta.gsb', 'hgridshift'], ['ntv2_0.gsb', 'hgridshift'], ['osgm15.gtx', 'vgridshift']]) {
      const id = geod.open(readFileSync(join(dir, f)), ROLE[op], f);
      try {
        const info = geod.info(id);
        expect(info.format).toBe(f.endsWith('.gsb') ? 'NTv2' : 'GTX');
        const pts = pointsFor(info, 1000, 5);
        const opts = op === 'vgridshift' ? { inverse: true, multiplier: 1 } : {};
        const r = compare(geod.apply(op, [id], pts, opts).pts, cct(PIPE[op](f), pts, [dir]), pts, `${f} ${op}`);
        r.grids = info.grids.length;
        REPORT.grids.push(r);
        expect(r.mismatches, JSON.stringify(r.firstMismatch)).toBe(0);
        expect(r.maxHorizontalM).toBeLessThanOrEqual(TOL);
        expect(r.maxVerticalM).toBeLessThanOrEqual(TOL);
      } finally {
        geod.close(id);
      }
    }
  }, 300_000);

  it('several grid sets in order: PROJ picks the first set that holds the point', () => {
    const a = join(GRIDS, 'us_noaa_nadcon5_nad27_nad83_1986_conus.tif');
    const b = join(GRIDS, 'ca_nrc_ntv2_0.tif');
    if (!existsSync(a) || !existsSync(b)) return;
    const ia = geod.open(readFileSync(b), 'horizontal', 'ca_nrc_ntv2_0.tif');
    const ib = geod.open(readFileSync(a), 'horizontal', 'us_noaa_nadcon5_nad27_nad83_1986_conus.tif');
    try {
      const pts = [[-79.4, 43.7, 0], [-100, 40, 0], [-123.1, 49.25, 0], [-70, 47, 0], [-140, 60, 0]];
      const ours = geod.apply('hgridshift', [ia, ib], pts).pts;
      const theirs = cct(['+proj=pipeline', '+step', '+proj=unitconvert', '+xy_in=deg', '+xy_out=rad', '+step', '+proj=hgridshift', '+grids=ca_nrc_ntv2_0.tif,us_noaa_nadcon5_nad27_nad83_1986_conus.tif', '+step', '+proj=unitconvert', '+xy_in=rad', '+xy_out=deg'], pts);
      const r = compare(ours, theirs, pts, 'hgridshift ca_nrc_ntv2_0 + nadcon5 nad27 list');
      REPORT.grids.push(r);
      expect(r.mismatches).toBe(0);
      expect(r.maxHorizontalM).toBeLessThanOrEqual(TOL);
    } finally {
      geod.close(ia);
      geod.close(ib);
    }
  });

  // ---- time-dependent frames ----
  const PAIRS = [
    ['ITRF2014', 'ITRF2020'],
    ['ITRF2008', 'ITRF2020'],
    ['ITRF2000', 'ITRF2014'],
    ['ITRF2005', 'ITRF2008'],
    ['ITRF97', 'ITRF2014'],
    ['ITRF93', 'ITRF2020'],
    ['ITRF88', 'ITRF2008'],
    ['ITRF2020', 'ITRF2014'],
    ['WGS 84 (G1762)', 'WGS 84 (G2139)'],
    ['WGS 84 (G1674)', 'WGS 84 (G1762)'],
    ['WGS 84 (G1150)', 'WGS 84 (G1762)'],
    ['WGS 84 (G2139)', 'WGS 84 (G2296)'],
    ['WGS 84 (G730)', 'WGS 84 (G873)'],
    ['WGS 84 (G2139)', 'ITRF2014'],
    ['WGS 84 (G2296)', 'ITRF2020'],
    ['ITRF2014', 'NAD83(2011)'],
    ['ITRF2020', 'NAD83(2011)'],
    ['ITRF2014', 'GDA2020'],
    ['ITRF2014', 'ETRF2014'],
    ['ITRF2020', 'ETRF2020'],
    ['ITRF2014', 'NAD83(CSRS)v7'],
  ];
  const EPOCHS = [2000.0, 2010.0, 2015.0, 2020.5, 2026.84];

  it('frame transformations at an epoch agree with the PROJ pipeline (projinfo + cct) within 1 mm', () => {
    const frames = geod.frames();
    const code = (n) => frames.find((f) => f.name === n).geographic3d;
    const r = rng(99);
    for (const [s, t] of PAIRS) {
      const src = `EPSG:${code(s)}`;
      const dst = `EPSG:${code(t)}`;
      const ours0 = geod.framePath(s, t);
      const pipe = execFileSync(`${BIN}/projinfo.exe`, ['-s', src, '-t', dst, '-o', 'PROJ', '-q', '--single-line', '--hide-ballpark', '--spatial-test', 'intersects'], { env: projEnv(), encoding: 'utf8' }).split(/\r?\n/).find((l) => l.startsWith('+proj='));
      expect(pipe, `${s} → ${t}: PROJ has no non-ballpark operation`).toBeTruthy();
      // Points in the target frame's area for regional frames.
      const area = { 'NAD83(2011)': [-120, -75, 25, 48], 'NAD83(CSRS)v7': [-130, -60, 43, 70], GDA2020: [115, 152, -40, -12], ETRF2014: [-8, 28, 37, 65], ETRF2020: [-8, 28, 37, 65] }[t] ?? [-180, 180, -80, 80];
      const pts = [];
      for (let i = 0; i < 60; i++) pts.push([area[0] + r() * (area[1] - area[0]), area[2] + r() * (area[3] - area[2]), r() * 3000 - 100]);
      for (const ep of EPOCHS) {
        const ours = geod.frameTransform(s, t, pts, ep);
        // projinfo pipelines take latitude first (EPSG axis order) and the epoch as the 4th coordinate.
        const theirs = cct(pipe.split(/\s+/).filter(Boolean), pts.map((p) => [p[1], p[0], p[2], ep])).map((v) => v && [v[1], v[0], v[2]]);
        const res = compare(ours.pts, theirs, pts, `${s} → ${t} @ ${ep}`);
        res.path = ours.path.steps.map((x) => `${x.inverse ? 'inv ' : ''}EPSG:${x.epsg}`).join(' + ');
        res.proj = pipe;
        REPORT.frames.push(res);
        expect(res.mismatches).toBe(0);
        expect(res.maxHorizontalM, `${s} → ${t} @ ${ep} via ${res.path}; PROJ ${pipe}`).toBeLessThanOrEqual(TOL);
        expect(res.maxVerticalM, `${s} → ${t} @ ${ep} via ${res.path}`).toBeLessThanOrEqual(TOL);
      }
      expect(ours0.steps.length).toBeGreaterThan(0);
    }
    // The measured agreement for the validation note (docs/validation/2.4/geod.md).
    const out = process.env.GEOD_REPORT ?? 'test-results/geod-golden.json';
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(REPORT, null, 1));
  }, 300_000);
});
