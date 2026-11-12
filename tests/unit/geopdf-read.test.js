// REQ-GAP-66 GeoPDF vector reading against GDAL's PDF driver (the oracle): FX-24 GeoPDFs written by
// GDAL in UTM, a Lambert conic in US feet, Albers, Mercator and WGS 84, Flate-compressed and not,
// with and without a structure tree, and a raster page with vector layers. The Rust read-out
// (gw_pdf_vectors) georeferenced by formats/geopdf-vectors.js must give GDAL's features, geometry
// types, vertices (within 1 mm, or 1e-8°) and attribute values. With the T&E corpus present, the
// unstructured US Topo layers are compared with GDAL's per-layer feature counts as well.
import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { geoPdfLayers, fitAffine, viewportTransform, init as initGeoPdf } from '../../app/src/formats/geopdf-vectors.js';
import proj4 from 'proj4';
import { crsOf, converter, sameDatumGeographic } from '../../app/src/geo/crs.js';
import { layerCrs, wkt1, unitsToMeters } from '../../app/src/formats/raster-crs.js';
import { readGeoJSON } from '../../app/src/vector/io.js';
import { t, gwError, msgOf } from '../../app/src/i18n/index.js';

// The app's modules, as features/geopdf.js hands them to the lazy block.
initGeoPdf({ proj4, crsOf, converter, sameDatumGeographic, layerCrs, wkt1, unitsToMeters, readGeoJSON, forWorker: (f) => f, t, gwError, msgOf });

const wasmDir = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release');
  } catch {
    return null;
  }
})();
const haveWasm = wasmDir && existsSync(join(wasmDir, 'gw_bundle_parse.wasm'));
const GDAL = process.env.GW_GDAL_BIN ?? 'E:/gwb-sidecar-deps/osgeo4w/root/bin';
const haveGdal = existsSync(join(GDAL, 'ogr2ogr.exe')) || existsSync(join(GDAL, 'ogr2ogr'));
const gdal = (cmd, args) => execFileSync(join(GDAL, cmd), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${GDAL}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, GDAL_DATA: resolve(GDAL, '../apps/gdal/share/gdal'), PROJ_DATA: resolve(GDAL, '../share/proj'), PROJ_LIB: resolve(GDAL, '../share/proj') } });
const FX = resolve('fixtures/fx24/geopdf');

async function bundle() {
  const { Bundle } = await import('../../app/src/wasm/abi.js');
  return new Bundle(new WebAssembly.Module(readFileSync(join(wasmDir, 'gw_bundle_parse.wasm'))), 'parse');
}

function read(parse, bytes) {
  const [p, n] = parse.put(bytes);
  try {
    if (parse.x.gw_pdf_scan(p, n) !== 0) throw new Error(parse.lastError());
    const scan = parse.outJson();
    if (parse.x.gw_pdf_vectors(p, n, 0, 0) !== 0) throw new Error(parse.lastError());
    return { scan, vec: parse.outJson() };
  } finally {
    parse.free(p, n);
  }
}

const flat = (c) => (typeof c[0] === 'number' ? [c] : c.flatMap(flat));

describe('REQ-GAP-66 GeoPDF georeferencing', () => {
  test('affine fit is exact on a projected page and reports degenerate control points', () => {
    const pts = [[0, 0], [100, 0], [100, 50], [0, 50]].map(([x, y]) => ({ x, y, X: 500000 + 2 * x - 0.1 * y, Y: 4e6 + 0.1 * x + 2 * y }));
    const f = fitAffine(pts);
    expect(f.residual).toBeLessThan(1e-9);
    expect(f.m[0]).toBeCloseTo(2, 12);
    expect(fitAffine([{ x: 0, y: 0, X: 0, Y: 0 }, { x: 1, y: 1, X: 1, Y: 1 }, { x: 2, y: 2, X: 2, Y: 2 }])).toBeNull();
    // A UTM viewport: GPTS from the corners, the page maps back onto the projected grid.
    const vp = { bbox: [0, 0, 200, 100], lpts: [0, 0, 0, 1, 1, 1, 1, 0], gpts: [34.5, -116.5, 34.5009, -116.5, 34.5009, -116.4978, 34.5, -116.4978], epsg: 32611 };
    const t = viewportTransform(vp);
    expect(t.error).toBeUndefined();
    expect(t.residual).toBeLessThan(0.5); // GPTS of a lat/lon rectangle are not exactly a UTM rectangle
    const unknown = viewportTransform({ ...vp, epsg: 999999, wkt: null });
    expect(unknown.error.message).toMatch(/not known/);
  });
});

describe.skipIf(!haveWasm)('REQ-GAP-66 GeoPDF vectors against GDAL (FX-24)', () => {
  const pdfs = existsSync(FX) ? readdirSync(FX).filter((f) => f.endsWith('.pdf')) : [];
  for (const name of pdfs) {
    test(name, async () => {
      const parse = await bundle();
      const { scan, vec } = read(parse, readFileSync(join(FX, name)));
      const truth = JSON.parse(readFileSync(join(FX, name.replace(/\.pdf$/, '_gdal.geojson')), 'utf8'));
      const geo = /wgs84/.test(name);
      const r = geoPdfLayers(vec, scan, { xy: true });
      expect(r.errors).toEqual([]);
      const feats = r.layers.flatMap((l) => l.features);
      expect(r.layers.map((l) => l.name)).toContain(truth.name);
      // GDAL keeps a feature that draws nothing (FX-12 "Wells", a MultiPoint its writer leaves empty) with no geometry.
      expect(feats.length).toBe(truth.features.length);
      let dmax = 0;
      let nv = 0;
      let quirk = 0;
      const src = JSON.parse(readFileSync('fixtures/fx12/fx12.geojson', 'utf8')).features;
      truth.features.forEach((t, i) => {
        const f = feats[i];
        if (!t.geometry) return expect(f.geometry).toBeNull();
        // GDAL reads a small filled square or short line of its own WGS 84 output back as a point
        // (its point-symbol heuristic works in georeferenced units, and degrees are small): the
        // source geometry decides those features.
        if (geo && t.geometry.type === 'Point' && f.geometry.type !== 'Point') {
          expect(src[i].geometry.type.replace('Multi', '')).toBe(f.geometry.type.replace('Multi', ''));
          quirk++;
          return;
        }
        expect(f.geometry.type).toBe(t.geometry.type);
        const a = flat(f.geometry.coordinates);
        const b = flat(t.geometry.coordinates);
        expect(a.length).toBe(b.length);
        a.forEach((p, k) => {
          dmax = Math.max(dmax, Math.hypot(p[0] - b[k][0], p[1] - b[k][1]));
          nv++;
        });
        // Attribute values as GDAL reads them (it types a field with mixed integer and real values as text).
        for (const [k, v] of Object.entries(t.properties)) expect(String(f.properties[k]), `${name} feature ${i} ${k}`).toBe(String(v));
        expect(Object.keys(f.properties).length).toBe(Object.keys(t.properties).length);
      });
      // Coordinates agree with GDAL to its 6-decimal GeoJSON output and the PDF's 6-decimal points.
      expect(dmax).toBeLessThan(geo ? 1e-8 : /ftus/.test(name) ? 0.004 : 0.001);
      expect(quirk).toBe(geo ? 4 : 0);
      console.log(`[geopdf-read] ${name}: ${feats.length} features, ${nv} vertices, max |Δ| vs GDAL ${dmax.toExponential(2)} ${geo ? 'deg' : /ftus/.test(name) ? 'ftUS' : 'm'}${quirk ? `; ${quirk} features GDAL reads as points` : ''}`);
    });
  }
});

// The T&E corpus US Topo maps (unstructured: optional-content layers, no attributes).
const CORPUS = resolve('..', 'TE-corpus');
const TOPO = [
  ['geopdf-ustopo-vinehill-2012/CA_Vine_Hill_20120213_TM_geo.pdf', 'fixtures/fx24/geopdf/ustopo_vinehill_2012_gdal_counts.json'],
  ['geopdf-ustopo-vinehill-honkerbay-current/CA_Honker_Bay_20220107_TM_geo.pdf', 'fixtures/fx24/geopdf/ustopo_honkerbay_2022_gdal_counts.json'],
];
describe.skipIf(!haveWasm)('REQ-GAP-66 US Topo optional-content layers against GDAL counts', () => {
  for (const [file, counts] of TOPO) {
    test.skipIf(!existsSync(join(CORPUS, file)) || !existsSync(counts))(file, async () => {
      const parse = await bundle();
      const t0 = performance.now();
      const { scan, vec } = read(parse, readFileSync(join(CORPUS, file)));
      const ms = performance.now() - t0;
      const truth = JSON.parse(readFileSync(counts, 'utf8'));
      const pg = vec.pages[0];
      expect(pg.structured).toBe(false);
      const ours = new Map();
      pg.layers.forEach((l, i) => ours.set(l.path.join('_').replace(/ /g, '_'), pg.features.filter((f) => f.l === i).length));
      let diff = 0;
      let total = 0;
      for (const [layer, n] of Object.entries(truth.layers)) {
        expect(ours.has(layer), layer).toBe(true);
        diff += Math.abs(ours.get(layer) - n);
        total += n;
        expect(Math.abs(ours.get(layer) - n) / n, layer).toBeLessThan(0.035);
      }
      console.log(`[geopdf-read] ${file}: ${ours.size} layers, ${total} GDAL features, |Δcount| ${diff} (${((100 * diff) / total).toFixed(2)} %), ${Math.round(ms)} ms`);
      // Georeferenced into the map frame: the collar is left out, the rest falls inside the neatline.
      const r = geoPdfLayers(vec, scan);
      expect(r.errors).toEqual([]);
      expect(r.layers.length).toBeGreaterThan(8);
      // Vertices against GDAL's read-out (UTM metres) of the layers whose feature counts agree.
      if (!haveGdal) return;
      const xy = geoPdfLayers(vec, scan, { xy: true });
      const dir = join(process.env.GW_GEOPDF_TMP ?? tmpdir(), 'gw-geopdf-read');
      mkdirSync(dir, { recursive: true });
      for (const [layer, n] of Object.entries(truth.layers).filter(([k, n]) => ours.get(k) === n && /Contour_Features|Hydrograph|Woodland|Road_Features/.test(k))) {
        const gj = join(dir, `${layer}.geojson`);
        if (existsSync(gj)) rmSync(gj);
        // At its default 150 DPI GDAL rounds the page to whole raster pixels and its vector
        // coordinates carry that (up to 1.5 m across a US Topo sheet); at 72 DPI a point is a pixel.
        gdal('ogr2ogr', ['-oo', 'DPI=72', '-f', 'GeoJSON', '-lco', 'COORDINATE_PRECISION=4', gj, join(CORPUS, file), layer]);
        const g = JSON.parse(readFileSync(gj, 'utf8')).features;
        const mine = xy.layers.find((L) => L.path.join('_').replace(/ /g, '_') === layer).features;
        // Each GDAL feature against ours that starts at the same vertex (within 1 m) with as many
        // vertices (features outside the frame are left out here and kept by GDAL; a polygon's rings
        // may be ordered differently).
        const cell = (p) => `${Math.round(p[0])},${Math.round(p[1])}`;
        const index = new Map();
        for (const f of mine) {
          const a = flat(f.geometry.coordinates);
          const key = cell(a[0]);
          if (!index.has(key)) index.set(key, []);
          index.get(key).push(a);
        }
        let dmax = 0;
        let nv = 0;
        let k = 0;
        let diffCount = 0;
        for (const f of g) {
          const b = flat(f.geometry.coordinates);
          const near = [];
          for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) near.push(...(index.get(`${Math.round(b[0][0]) + dx},${Math.round(b[0][1]) + dy}`) ?? []));
          // Several features can start at one vertex (roads at a junction): the closest candidate,
          // each vertex against its nearest GDAL vertex of the feature (rings may come in another order).
          const dist = (a) => Math.max(...a.map((q) => Math.min(...b.map((r) => Math.hypot(q[0] - r[0], q[1] - r[1])))));
          const cands = near.filter((q) => q.length === b.length && Math.hypot(q[0][0] - b[0][0], q[0][1] - b[0][1]) < 1).map(dist);
          if (!cands.length) {
            if (near.length) diffCount++;
            continue;
          }
          dmax = Math.max(dmax, Math.min(...cands));
          nv += b.length;
          k++;
        }
        console.log(`[geopdf-read] ${file} ${layer}: ${k}/${n} features matched (${diffCount} start alike with other vertex counts), ${nv} vertices, max |Δ| vs GDAL ${dmax.toExponential(2)} m`);
        expect(k / n, layer).toBeGreaterThan(0.9);
        expect(dmax, layer).toBeLessThan(0.01);
      }
    }, 240_000); // GDAL and the corpus are on E:, a USB disk that can stay busy for hours
  }
});
