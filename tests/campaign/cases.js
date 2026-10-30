// Ingest cases shared by c01 (open every primary file) and c50 (cross every primary file with every
// command it enables): the files a user would select together, named refusals, census format keys.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { manifest, paths, HDF5_PACK, PROJ_PACK, ASCII_CRS, isAscii } from './helpers.js';
import { filePath } from '../../build/campaign/corpus-lib.mjs';
// Named refusals and per-layer gaps already accepted (keep in step with tests/e2e/samples.spec.js).
export const EXPECT = {
  'ns3114a.nsf': { refuse: /no displayable image/ },
  // TE-047: 4607 files with neither dwells nor platform locations are refused by name, listing their segments.
  'free_text_and_test_status.gmti': { refuse: /no dwell or platform location segments/ },
  'processing_history_chain.gmti': { refuse: /no dwell or platform location segments/ },
  // TE-010: NITF 2.0 conformance files with no image segment (GDAL: 0 bands).
  ...Object.fromEntries(['U_1051e', 'U_1052a', 'U_1056a', 'U_1060a', 'U_1064a', 'U_1068a', 'U_0006a'].map((n) => [`${n}.ntf`, { refuse: /no displayable image/ }])),
  // TE-011: NITF 1.1 is read from 2.0.4 (2.0 layout). U_0001a's ARIDPCM images (IC=C2) are refused
  // by name while its last image opens; U_0002a is a header alone and U_0004a holds symbols only.
  'U_0001a.ntf': { allowLayer: /ARIDPCM compression \(IC=C2\) is not decoded/ },
  ...Object.fromEntries(['U_0002a', 'U_0004a'].map((n) => [`${n}.ntf`, { refuse: /no displayable image/ }])),
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
  // TE archive (2026-10-28): limits that are by design, each refused with its reason.
  'simple-extra.bpf': { refuse: /coordinate type Cartesian is not read/ }, // no CRS to place it
  'AIS_2023_06_01.csv': { refuse: /read whole into memory/ }, // 900 MB, above the OD-07 cap
  'A.TOC': { refuse: /table of contents \(A\.TOC\) is not read/ },
  'Raw_Video.mpeg': { refuse: /MPEG program stream/ },
  'Custom_FMV_Field_Mappings.csv': { refuse: /no WKT column/ }, // Esri multiplexer configuration, not data
  'FMV_Multiplexer_TimeShift_Template.csv': { refuse: /no WKT column/ },
  'byte_one_poc.j2k': { refuse: /progression order change \(POC marker\) is not decoded/ },
  'single_tile_brotli.pmtiles': { refuse: /Brotli-compressed PMTiles/ }, // the pmtiles library has gzip only
  'data.xyz': { refuse: /coordinate system is not set/ }, // GDAL's XYZ sample: projected, CRS unknown
  // DFC2019 Track 4 clouds: metres from each tile's own origin (no CRS), refused by name.
  ...Object.fromEntries(['JAX_114', 'JAX_215', 'JAX_250', 'JAX_328', 'JAX_342', 'OMA_094', 'OMA_099', 'OMA_241', 'OMA_243', 'OMA_290'].map((n) => [`${n}_PC3.txt`, { refuse: /coordinate system is not set/ }])),
  // CesiumJS 3TZ test packages: unit-box tilesets with no transform to ECEF (nothing places them).
  ...Object.fromEntries(['simple', 'tilesetA', 'tilesetB', 'tilesetC', 'tilesetD', 'validTilesetPackage', 'validTilesetPackageZipped', 'tilesetPackageWithWarnings'].map((n) => [`${n}.3tz`, { refuse: /not georeferenced/ }])),
  // Point-cloud exports with projected X/Y as CSV: refused by the vector reader with the ASCII route.
  'autzen.csv': { refuse: /projected coordinates, not longitude\/latitude/ },
  'test1_4.csv': { refuse: /projected coordinates, not longitude\/latitude/ },
  'houston_c1.csv': { refuse: /projected coordinates, not longitude\/latitude/ },
  'sicd_example_1_PFA_AMP8I_PHS8I_VV_no_amplitude_table_SICD.nitf': { refuse: /need ImageData\/AmpTable/ },
  // FlatGeobuf/GeoParquet test files the readers (2.0.4) refuse by name: a 12-byte stub, no features,
  // a Json column that holds plain text, a Triangle surface the GeoJSON converter does not carry.
  'invalid.parquet': { refuse: /not a Parquet file|footer is not readable/ },
  'empty.fgb': { refuse: /has no features/ },
  'test_ogr_flatgeobuf_coordinate_epoch.fgb': { refuse: /has no features/ },
  'alldatatypes.fgb': { refuse: /Json column holds text that is not JSON/ },
  'triangle.fgb': { refuse: /no geometry the reader converts \(Triangle\)/ },
};
// Negative samples (TE archive): a file whose census keys include a format the app refuses
// (formats.json status "refused": ECW, HFA, NetCDF-3, OJPEG, CPHD, MBTiles, Draco glTF…) must be
// refused with a message that names what it is — the generic "unrecognised data" does not count.
export const FORMATS = JSON.parse(readFileSync(resolve('build/campaign/formats.json'), 'utf8')).formats;
export const CENSUS = (() => {
  const p = resolve('reports/campaign/format-census.json');
  return existsSync(p) ? new Map(JSON.parse(readFileSync(p, 'utf8')).files.map((r) => [`${r.id}/${r.file}`, r.keys])) : new Map();
})();
export const refusedKeys = (it, f) => (CENSUS.get(`${it.id}/${f.name}`) ?? []).filter((k) => FORMATS[k]?.status === 'refused');
export const GENERIC = /unrecognised data cannot be opened/;
// Robustness seeds are malformed on purpose: they must fail by name (no console error, no hang).
export const ROBUST = (it) => it.area === 'robustness' || it.id === 'gdal-autotest-dted-edge';
export const SKIP_EXT = /\.(txt|json|xml|html?|md|pdf\.aux\.xml)$/i;

export const cases = [];
for (const it of manifest.items) {
  // Tier-B (login) items are ingested once the owner has downloaded them; absent files skip below.
  // Tier U is field data a user supplied (build/campaign/field.mjs, phase F).
  if (!['A', 'B', 'U'].includes(it.tier) && it.origin !== 'research-samples') continue;
  const sidecars = paths(it, ['sidecar']);
  // ASCII clouds (.txt in a lidar item) and the app's own JSON files (recipes, templates) are data here.
  for (const f of it.files.filter((x) => (x.role ?? 'primary') === 'primary' && (!SKIP_EXT.test(x.name) || isAscii(it, x) || /\.(gwrecipe|gwt)\.json$/i.test(x.name)))) {
    // By the full relative name: sample sets repeat one file name in several folders (glTF variants).
    const prim = filePath(it, f);
    const stem = f.name.split('/').pop().replace(/\.[^.]+$/, '');
    const base = (p) => p.split(/[\\/]/).pop();
    const dir = (p) => p.replace(/[\\/][^\\/]*$/, '');
    // A .gltf is opened with the buffers and textures beside it, as a user would select them.
    const res = /\.gltf$/i.test(f.name) ? paths(it, ['primary', 'sidecar', 'test-vector']).filter((p) => p !== prim && dir(p) === dir(prim) && /\.(bin|png|jpe?g|webp|ktx2)$/i.test(p)) : [];
    const pack = HDF5_PACK && /\.(nc|h5|he5|hdf5)$/i.test(f.name) ? [HDF5_PACK] : PROJ_PACK && ASCII_CRS[f.name.split('/').pop()] ? [PROJ_PACK] : [];
    cases.push({ it, f, files: [...pack, prim, ...res, ...sidecars.filter((s) => base(s).startsWith(`${stem}.`) || base(s).startsWith(`${f.name.split('/').pop()}.`))] });
  }
}

// Requirement IDs by format, so traceability gets a last result per format (incl. TE_REQS rows).
export const reqsFor = (it, f) => {
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

// Stratified: up to 3 files per census format key (each from a different item), plus one file of
// every item the census gave no key.
export function stratify(all) {
  const keyed = new Map();
  for (const c of all) for (const k of CENSUS.get(`${c.it.id}/${c.f.name}`) ?? []) (keyed.get(k) ?? keyed.set(k, []).get(k)).push(c);
  const pick = new Set();
  for (const list of keyed.values()) {
    const items = new Set();
    for (const c of list) {
      if (items.size >= 3) break;
      if (items.has(c.it.id)) continue;
      items.add(c.it.id);
      pick.add(c);
    }
  }
  const seenItem = new Set([...pick].map((c) => c.it.id));
  for (const c of all) if (!seenItem.has(c.it.id)) (seenItem.add(c.it.id), pick.add(c));
  return all.filter((c) => pick.has(c));
}

