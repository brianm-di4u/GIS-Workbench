// REQ-GAP-66 GeoPDF writing (formats/geopdf-writer.js): FX-12 drawn in projected CRSs (UTM, a
// Lambert conic in US feet, Albers, Mercator) and in WGS 84, with a main and an overview frame,
// attributes in GDAL's structure-tree layout, Unicode labels through the fonts-noto pack inputs
// (Helvetica and '?' without them) and Flate content. Read back by the app's own reader and by
// GDAL's PDF driver (the oracle; skipped when GDAL is not installed): CRS, layers, attribute
// values and vertices against the source geometry.
import { describe, test, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import vm from 'node:vm';
import * as esbuild from 'esbuild';
import { zlibSync, unzlibSync } from 'fflate';
import { layout, compose, writeGeoPdf, textsOf, boldTextsOf, pdfValue, niceLength } from '../../app/src/formats/geopdf-writer.js';
import { frameCrs, geoPdfLayers, utmEpsg, init as initGeoPdf } from '../../app/src/formats/geopdf-vectors.js';
import proj4 from 'proj4';
import { crsOf, converter, sameDatumGeographic } from '../../app/src/geo/crs.js';
import { layerCrs, wkt1, unitsToMeters } from '../../app/src/formats/raster-crs.js';
import { readGeoJSON } from '../../app/src/vector/io.js';
import { t, gwError, msgOf } from '../../app/src/i18n/index.js';

// The app's modules, as features/geopdf.js hands them to the lazy block.
initGeoPdf({ proj4, crsOf, converter, sameDatumGeographic, layerCrs, wkt1, unitsToMeters, readGeoJSON, forWorker: (f) => f, t, gwError, msgOf });
import { PdfFonts, FONT_FILES } from '../../app/src/formats/pdf-text.js';
import { fontkitBundle } from '../../build/packs.mjs';

const FX12 = JSON.parse(readFileSync('fixtures/fx12/fx12.geojson', 'utf8'));
const FONTS = join('.cache', 'packs-src', 'fonts');
const haveFonts = Object.values(FONT_FILES).every((f) => existsSync(join(FONTS, f)));
const GDAL = process.env.GW_GDAL_BIN ?? 'D:/gwb-sidecar-deps/osgeo4w/root/bin';
const haveGdal = existsSync(join(GDAL, 'ogr2ogr.exe')) || existsSync(join(GDAL, 'ogr2ogr'));
const gdalEnv = { ...process.env, PATH: `${GDAL}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, GDAL_DATA: resolve(GDAL, '../apps/gdal/share/gdal'), PROJ_DATA: resolve(GDAL, '../share/proj'), PROJ_LIB: resolve(GDAL, '../share/proj') };
const gdal = (cmd, args) => execFileSync(join(GDAL, cmd), args, { env: gdalEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const TMP = join(process.env.GW_GEOPDF_TMP ?? tmpdir(), `gw-geopdf-write-${process.pid}`); // one per worker: two runs must not share files

const wasmDir = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release');
  } catch {
    return null;
  }
})();
const haveWasm = wasmDir && existsSync(join(wasmDir, 'gw_bundle_parse.wasm'));

async function fontsFor(strings, bold) {
  if (!haveFonts) return null;
  if (!globalThis.__lib?.fontkit) vm.runInThisContext(await fontkitBundle(esbuild));
  const f = new PdfFonts({ fontkit: globalThis.__lib.fontkit, fontBytes: (k) => readFileSync(join(FONTS, FONT_FILES[k])), locale: 'en' });
  f.add(strings);
  if (bold.length) f.add(bold, { bold: true });
  return f.finish();
}

const flat = (c) => (typeof c[0] === 'number' ? [c] : c.flatMap(flat));

/** FX-12 (moved by `shift` when given) as the writer's layer, the name as the label. */
function fx12Layer(shift = null) {
  const mv = (c) => (typeof c[0] === 'number' ? (shift ? [c[0] + shift[0], c[1] + shift[1]] : [c[0], c[1]]) : c.map(mv));
  return {
    name: 'Ортофото слой 建物',
    style: { stroke: '#c00000', fill: '#ffcc0080', width: 1.2 },
    attributes: true,
    features: FX12.features.map((f) => ({ geom: { type: f.geometry.type, coordinates: mv(f.geometry.coordinates) }, label: f.properties.name ?? null, attrs: f.properties })),
  };
}

async function writeFx12(epsg, { overview = true, shift = null, fonts = true } = {}) {
  const F = frameCrs(epsg);
  const V = fx12Layer(shift);
  const ll = V.features.flatMap((f) => flat(f.geom.coordinates));
  const XY = ll.map(([lon, lat]) => F.fwd(lon, lat));
  const ext = [Math.min(...XY.map((p) => p[0])), Math.min(...XY.map((p) => p[1])), Math.max(...XY.map((p) => p[0])), Math.max(...XY.map((p) => p[1]))];
  const pad = (ext[2] - ext[0]) * 0.1;
  const main = [ext[0] - pad, ext[1] - pad, ext[2] + pad, ext[3] + pad];
  const cx = (main[0] + main[2]) / 2;
  const cy = (main[1] + main[3]) / 2;
  const s = 3 * (main[2] - main[0]);
  const L = layout({ widthMm: 297, heightMm: 210, main: { name: 'Main map', extent: main }, overview: overview ? { name: 'Overview', extent: [cx - s, cy - s, cx + s, cy + s] } : null });
  const gcs = { epsg, wkt: F.wkt, projected: F.projected };
  const frames = [{ name: 'Main map', gcs, toLatLon: F.toLatLon, fwd: F.fwd, image: null, layers: [V] }];
  if (overview) frames.push({ name: 'Overview', gcs, toLatLon: F.toLatLon, fwd: F.fwd, image: null, layers: [{ ...V, attributes: false }], extentOf: L.frames[0].extent });
  const doc = compose(L, { title: 'FX-12 карта 地図 — GeoPDF', frames, units: F.units, notes: [`${F.label} · EPSG:${epsg}`] });
  const f = fonts ? await fontsFor(textsOf(doc), boldTextsOf(doc)) : null;
  return { bytes: writeGeoPdf(doc, { fonts: f, deflate: (u8) => zlibSync(u8, { level: 6 }) }), F, L, doc, fonts: f };
}

/** The source vertices of feature i in the CRS (GeoJSON nesting flattened). */
const srcXY = (F, i) => flat(FX12.features[i].geometry.coordinates).map(([lon, lat]) => F.fwd(lon, lat));

describe('REQ-GAP-66 GeoPDF writer', () => {
  test('values, scale bar lengths and the frame CRS of each projection', () => {
    expect(pdfValue(3)).toBe('3');
    expect(pdfValue(12.5)).toBe('12.5');
    expect(pdfValue(true)).toBe('1');
    expect(pdfValue(null)).toBeNull();
    expect(pdfValue('')).toBeNull();
    expect(pdfValue('Склад')).toBe('<FEFF0421043A043B04300434>');
    expect(niceLength(740)).toBe(500);
    expect(niceLength(0.03)).toBe(0.02);
    expect(utmEpsg(-116.5, 34.5)).toBe(32611);
    expect(utmEpsg(151.2, -33.9)).toBe(32756);
    const utm = frameCrs(32611);
    expect(utm.projected).toBe(true);
    expect(utm.wkt).toMatch(/^PROJCS\[.*Transverse_Mercator.*AUTHORITY\["EPSG","32611"\]\]$/);
    // GPTS round trip: X/Y → lat/lon (own datum) → X/Y.
    const [lat, lon] = utm.toLatLon(545950, 3817750);
    const [X, Y] = utm.fwd(lon, lat);
    expect(Math.hypot(X - 545950, Y - 3817750)).toBeLessThan(1e-6);
    expect(frameCrs(4326).projected).toBe(false);
    expect(frameCrs(2229).units).toBeCloseTo(0.3048006096, 9);
    expect(() => frameCrs(999999)).toThrow(/not known/);
  });

  test('page structure: two viewports, optional content, the structure tree and Flate content', async () => {
    const { bytes, L } = await writeFx12(32611);
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text.match(/\/Type \/Viewport/g)).toHaveLength(2);
    expect(text.match(/\/Subtype \/GEO/g)).toHaveLength(2);
    expect(text).toMatch(/\/Type \/PROJCS \/EPSG 32611 \/WKT \(PROJCS\[/);
    expect(text).toContain('/MarkInfo << /Marked true /UserProperties true >>');
    expect(text.match(/\/S \/feature /g)).toHaveLength(11);
    expect(text).toMatch(/\/Filter \/FlateDecode/);
    expect(L.frames[0].box[2]).toBeLessThan(L.frames[1].box[0]); // side by side, not overlapping
    // The content stream inflates to marked features inside optional content.
    const m = /(\d+) 0 obj\n<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/.exec(text);
    const start = m.index + m[0].length;
    const content = new TextDecoder().decode(unzlibSync(bytes.subarray(start, start + Number(m[2]))));
    expect(content).toMatch(/^\/OC \/oc0 BDC/);
    expect(content.match(/\/feature <<\/MCID \d+>> BDC/g)).toHaveLength(11);
  });
});

describe.skipIf(!haveWasm)('REQ-GAP-66 GeoPDF writer → the app reader', () => {
  for (const epsg of [32611, 2229, 5070, 3857, 4326]) {
    test(`EPSG:${epsg}`, async () => {
      const { Bundle } = await import('../../app/src/wasm/abi.js');
      const parse = new Bundle(new WebAssembly.Module(readFileSync(join(wasmDir, 'gw_bundle_parse.wasm'))), 'parse');
      const { bytes, F } = await writeFx12(epsg, { fonts: epsg === 32611 });
      const [p, n] = parse.put(bytes);
      expect(parse.x.gw_pdf_scan(p, n)).toBe(0);
      const scan = parse.outJson();
      expect(parse.x.gw_pdf_vectors(p, n, 0, 0)).toBe(0);
      const vec = parse.outJson();
      parse.free(p, n);
      expect(scan.pages[0].viewports.map((v) => v.epsg)).toEqual([epsg, epsg]);
      const r = geoPdfLayers(vec, scan, { xy: true });
      expect(r.errors).toEqual([]);
      expect(vec.pages[0].structured).toBe(true);
      const L = r.layers[0];
      expect(L.name).toBe('Ортофото слой 建物');
      expect(L.features).toHaveLength(11);
      let dmax = 0;
      L.features.forEach((f, i) => {
        const want = FX12.features[i];
        // Null values are left out, as GDAL writes them.
        for (const [k, v] of Object.entries(want.properties)) expect(f.properties[k] ?? null, `${i} ${k}`).toBe(typeof v === 'boolean' ? (v ? 1 : 0) : v);
        expect(f.geometry.type).toBe(want.geometry.type);
        const a = flat(f.geometry.coordinates);
        const b = srcXY(F, i);
        expect(a.length).toBe(b.length);
        a.forEach((q, k) => (dmax = Math.max(dmax, Math.hypot(q[0] - b[k][0], q[1] - b[k][1]))));
      });
      // 0.001 pt of page coordinate: about 0.1 mm at this scale (1e-9° in WGS 84).
      expect(dmax).toBeLessThan(epsg === 4326 ? 2e-8 : epsg === 2229 ? 0.003 : 0.001);
      console.log(`[geopdf-write] EPSG:${epsg} app reader: 11 features, max |Δ| ${dmax.toExponential(2)} ${epsg === 4326 ? 'deg' : epsg === 2229 ? 'ftUS' : 'm'}`);
    });
  }
});

describe.skipIf(!haveGdal)('REQ-GAP-66 GeoPDF writer → GDAL PDF driver (oracle)', { timeout: 60000 }, () => {
  for (const epsg of [32611, 2229, 5070, 3857, 4326]) {
    test(`EPSG:${epsg}`, async () => {
      mkdirSync(TMP, { recursive: true });
      const { bytes, F } = await writeFx12(epsg, { fonts: epsg === 32611 });
      const pdf = join(TMP, `fx12_${epsg}.pdf`);
      const gj = join(TMP, `fx12_${epsg}.geojson`);
      writeFileSync(pdf, bytes);
      if (existsSync(gj)) rmSync(gj);
      const info = JSON.parse(gdal('gdalinfo', ['-json', pdf]));
      const wkt = info.coordinateSystem.wkt;
      // GDAL identifies the CRS: the EPSG code is the projection's authority.
      expect(wkt).toMatch(new RegExp(`ID\\["EPSG",${epsg}\\]\\]$`));
      gdal('ogr2ogr', ['-f', 'GeoJSON', '-lco', 'RFC7946=NO', '-lco', 'COORDINATE_PRECISION=7', gj, pdf]);
      const g = JSON.parse(readFileSync(gj, 'utf8'));
      expect(g.name).toBe('Ортофото слой 建物');
      expect(g.features).toHaveLength(11);
      let dmax = 0;
      let points = 0;
      let multi = 0;
      g.features.forEach((f, i) => {
        const want = FX12.features[i];
        // GDAL types a field with integer and real values as text, and booleans written as 1/0 as integers.
        for (const [k, v] of Object.entries(want.properties)) expect(String(f.properties[k] ?? null), `${i} ${k}`).toBe(String(typeof v === 'boolean' ? (v ? 1 : 0) : v));
        // GDAL reads a MultiPoint (several circles in one feature) as its first point.
        if (want.geometry.type === 'MultiPoint' && f.geometry.type === 'Point') {
          const b0 = srcXY(F, i)[0];
          dmax = Math.max(dmax, Math.hypot(f.geometry.coordinates[0] - b0[0], f.geometry.coordinates[1] - b0[1]));
          multi++;
          return;
        }
        // GDAL's point-symbol heuristic reads small squares as points in degrees (see geopdf-read.test.js).
        if (f.geometry.type !== want.geometry.type) {
          expect(epsg).toBe(4326);
          points++;
          return;
        }
        const a = flat(f.geometry.coordinates);
        const b = srcXY(F, i);
        expect(a.length).toBe(b.length);
        a.forEach((q, k) => (dmax = Math.max(dmax, Math.hypot(q[0] - b[k][0], q[1] - b[k][1]))));
      });
      expect(dmax).toBeLessThan(epsg === 4326 ? 1e-7 : epsg === 2229 ? 0.01 : 0.003);
      console.log(`[geopdf-write] EPSG:${epsg} GDAL ${gdal('gdalinfo', ['--version']).trim().split(',')[0]}: 11 features, attributes equal, max |Δ| ${dmax.toExponential(2)} ${epsg === 4326 ? 'deg' : epsg === 2229 ? 'ftUS' : 'm'}${points ? `, ${points} read as points` : ''}${multi ? `, ${multi} MultiPoint read as its first point` : ''}`);
      // Unicode text: Poppler's pdftotext (when installed) reads the labels and the title back.
      const pt = spawnSync('pdftotext', ['-enc', 'UTF-8', pdf, '-'], { encoding: 'utf8' });
      if (!pt.error && haveFonts && epsg === 32611) for (const s of ['Склад', '仓库', 'FX-12 карта 地図']) expect(pt.stdout).toContain(s);
    });
  }
});
