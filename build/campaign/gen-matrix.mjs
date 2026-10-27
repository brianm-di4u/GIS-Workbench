// T&E functional-coverage matrix: every catalogued command × the context it needs × the corpus
// items that can satisfy that context × the check that proves it worked. Drives tests/campaign
// (Phase 2 exit: every implemented command exercised on real data).
//
//   node build/campaign/gen-matrix.mjs
// Reads app/src/shell/commands.js (CATALOG), app/src/shell/ribbon-data.js (where each command lives
// and which contextual set gates it), build/campaign/corpus.json and, when present,
// reports/campaign/registry.json (runtime implemented flags dumped by tests/campaign/c00-registry).
// Writes reports/campaign/matrix.{json,md}.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO, loadManifest } from './corpus-lib.mjs';

const src = readFileSync(join(REPO, 'app/src/shell/commands.js'), 'utf8');
const catalog = [...src.matchAll(/^\s*\['([a-z0-9_.]+)',\s*'((?:[^'\\]|\\.)*)',\s*'[^']*',\s*'([^']*)',\s*'(R\d)'/gm)].map(([, id, label, req, rel]) => ({ id, label: label.replace(/\\'/g, "'"), req, rel }));
const { CONTEXT_SETS, MAIN_TABS, QAT, FILE_MENU, WORKSPACE_MENUS } = await import(pathToFileURL(join(REPO, 'app/src/shell/ribbon-data.js')).href);

// Collect every command id under a ribbon/menu structure.
function ids(node, out = new Set()) {
  if (!node) return out;
  if (typeof node === 'string') return node !== '-' && out.add(node), out;
  if (Array.isArray(node)) return node.forEach((n) => ids(n, out)), out;
  if (typeof node === 'object') {
    if (typeof node.cmd === 'string') out.add(node.cmd);
    if (typeof node.launcher === 'string') out.add(node.launcher);
    for (const k of ['items', 'groups', 'tabs', 'menu']) ids(node[k], out);
  }
  return out;
}

const where = new Map(); // id → [location]
const add = (id, loc) => where.set(id, [...(where.get(id) ?? []), loc]);
for (const t of MAIN_TABS) for (const id of ids(t)) add(id, `tab:${t.id ?? t.label}`);
for (const c of CONTEXT_SETS) for (const id of ids(c)) add(id, `ctx:${c.id}`);
for (const id of ids(QAT)) add(id, 'qat');
for (const id of ids(FILE_MENU)) add(id, 'file-menu');
for (const id of ids(WORKSPACE_MENUS)) add(id, 'workspace-menu');

// Context → what the corpus must supply to make the contextual tab appear.
const NEEDS = {
  image: { areas: ['eo', 'nitf', 'landsat', 'sentinel2', 'naip', 'dem', 'sar', 'hsi', 'raster'], n: 1 },
  spectral: { areas: ['eo', 'landsat', 'sentinel2', 'naip', 'hsi'], tag: 'msi', n: 1 },
  video: { areas: ['fmv'], n: 1 },
  sar: { areas: ['sar'], n: 1 },
  layer: { areas: ['eo', 'nitf', 'landsat', 'sentinel2', 'naip', 'sar'], n: 2 },
  surface: { areas: ['dem'], n: 1 },
  stereo: { areas: ['eo'], tag: 'stereo', n: 2 },
  scene3d: { areas: ['dem', 'lidar', '3d'], n: 1 },
  pointcloud: { areas: ['lidar'], n: 1 },
  feature: { areas: ['vector'], n: 1 },
  observation: { areas: ['eo', 'nitf'], n: 1, note: 'observations are created in-app first' },
};

// Command id → campaign spec (area).
const SPECS = [
  [/^file\.open|^fmv\.open|^det\.import|^file\.opengpkg|^pc\.stream/, 'c01-ingest'],
  [/^(nav|rot|link|ws|win|theme|display|view|deco|bm|ov|grid|lay|cmp|panel|bg|online|input)\.|^geo\.grid/, 'c02-display'],
  [/^(enh|bands|clip|img)\./, 'c03-enhance'],
  [/^geo\./, 'c04-geodesy'],
  [/^(model|align|tri|ortho)\./, 'c05-sensor'],
  [/^(stereo|3d)\./, 'c06-stereo3d'],
  [/^(dem|los)\.|^profile\.elevation/, 'c07-terrain'],
  [/^sar\./, 'c08-sar'],
  [/^(msi|search)\.|^profile\.spectral/, 'c09-msi'],
  [/^pc\./, 'c10-lidar'],
  [/^(fmv|mie)\./, 'c11-fmv'],
  [/^(sel|ext|vec|det|obs|chg)\./, 'c12-vector'],
  [/^men\./, 'c13-measure'],
  [/^(draw|gfx|aoi)\.|^edit\.(copy|paste|delete)/, 'c14-annotate'],
  [/^(chip|prod|tpl|snap|report)\.|^meta\.redact|^file\.print/, 'c15-products'],
  [/^(ai|auto|wb)\./, 'c16-ai-mcp'],
];
const specOf = (id) => SPECS.find(([re]) => re.test(id))?.[1] ?? 'c17-workspace';

// Quantitative oracle checks (Appendix E tolerances); everything else is a smoke check:
// state change, no console/CSP/page error, no unrequested network request.
const ORACLES = {
  'men.length': 'geodesic distance vs GeographicLib ≤ 1 mm/10 km (AT-03.x)',
  'men.area': 'geodesic area vs GeographicLib ≤ 0.1 % (AT-03.x)',
  'men.rangebearing': 'inverse geodesic vs GeographicLib',
  'men.point': 'ground point vs sarpy/GDAL RPC projection; CE90/LE90 = 2.146σ/1.645σ ± 1 %',
  'men.height': 'layover/shadow height ± max(0.5 m, 2–3 %)',
  'geo.convert': 'MGRS/UTM/UPS/GARS/GEOREF vs GeographicLib + NGS NCAT (truncation rule)',
  'geo.datum': 'HAE↔MSL vs NGS geoid API ≤ 0.2 m (EGM96)',
  'los.viewshed': 'gdal_viewshed agreement ≥ 99 % (-cc 0.87, S-15)',
  'los.p2p': 'line of sight vs profile from GDAL',
  'dem.hillshade': 'gdaldem hillshade ±1 DN',
  'dem.slope': 'gdaldem slope ±0.1°',
  'dem.aspect': 'gdaldem aspect ±0.5°',
  'dem.save': 'gdalinfo of written COG/DTED (3601² posts for L2)',
  'dem.groundfilter': 'DTM RMSEz vs 3DEP DEM ≤ 0.15 m',
  'pc.groundfilter': 'PDAL filters.smrf class agreement; DTM RMSEz ≤ 0.15 m',
  'pc.header': 'header fields vs laspy/PDAL',
  'pc.export': 'laspy re-read of written LAS 1.4 (point count, bbox, classes)',
  'pc.dsm': 'PDAL writers.gdal max-Z grid',
  'pc.dtm': 'PDAL SMRF + writers.gdal min-Z grid',
  'sar.metadata': 'SICD fields vs sarpy',
  'sar.ground': 'image→ground corners vs SARkit ≤ 0.01 m; round trip ≤ 0.05 px',
  'sar.remap': 'remap switch < 200 ms, no file re-read',
  'sar.ccd': 'coherence ≥ 0.8 stable / ≤ 0.4 disturbed vs numpy',
  'msi.radiometric': 'TOA reflectance vs MTL/MTD formula in numpy',
  'msi.index.ndvi': 'NDVI vs numpy ± 0.01',
  'msi.accuracy': 'OA/κ vs scikit-learn (3 decimals)',
  'msi.cluster': 'overall accuracy ≥ 90 % on Indian Pines truth',
  'fmv.klv': 'ST 0601 tags vs klvdata',
  'fmv.capture': 'footprint vs KLV corner tags ≤ 1 m',
  'fmv.link': 'map/video sync ≤ 33 ms',
  'ext.square': 'corners 90° ± 0.1°',
  'ext.saveas': 'GeoJSON round trip 1e-9°; GPKG via OGC ETS; SHP/KML via ogrinfo',
  'ext.validate': 'topology errors vs GDAL/GEOS validity',
  'file.print': '1:5000 print scale within 0.5 %',
  'snap.pdf': 'pypdf/veraPDF structure; GeoPDF registration',
  'snap.pptx': 'python-pptx re-read',
  'snap.kmz': 'ogrinfo re-read',
  'chip.view': 'chip geolocation vs gdalinfo of written GeoTIFF/NITF',
  'ortho.rectify': 'orthoimage vs gdalwarp -rpc on the same DEM (≤ 1 GSD)',
  'tri.adjust': 'checkpoint RMSE ≤ 1.5 GSD',
};

const runtime = existsSync(join(REPO, 'reports/campaign/registry.json')) ? JSON.parse(readFileSync(join(REPO, 'reports/campaign/registry.json'), 'utf8')) : null;
const impl = runtime ? new Map(runtime.commands.map((c) => [c.id, c.implemented])) : null;

const corpus = loadManifest().items;
const eligible = (ctx) => {
  const need = NEEDS[ctx];
  if (!need) return [];
  return corpus.filter((it) => it.files.length && need.areas.includes(it.area) && (!need.tag || it.feeds?.includes(need.tag) || it.feeds?.some((f) => f.startsWith(need.tag)))).map((it) => it.id);
};

const rows = catalog.map((c) => {
  const locs = where.get(c.id) ?? [];
  const ctxs = locs.filter((l) => l.startsWith('ctx:')).map((l) => l.slice(4));
  const ctx = ctxs[0] ?? null;
  const data = ctx ? eligible(ctx) : corpus.filter((it) => it.feeds?.some((f) => f === c.id || c.id.startsWith(`${f}.`))).map((it) => it.id);
  return {
    ...c,
    spec: specOf(c.id),
    implemented: impl ? (impl.get(c.id) ?? null) : null,
    locations: locs,
    context: ctxs,
    needs: ctx ? NEEDS[ctx] : null,
    data: data.slice(0, 12),
    dataCount: data.length,
    check: ORACLES[c.id] ? 'oracle' : 'smoke',
    oracle: ORACLES[c.id] ?? null,
  };
});

const gaps = rows.filter((r) => r.implemented !== false && r.context.length && !r.dataCount).map((r) => r.id);
const summary = {
  generated: new Date().toISOString(),
  commands: rows.length,
  implemented: impl ? rows.filter((r) => r.implemented).length : null,
  placeholders: impl ? rows.filter((r) => r.implemented === false).map((r) => r.id) : null,
  unplaced: rows.filter((r) => !r.locations.length).map((r) => r.id),
  oracleChecked: rows.filter((r) => r.check === 'oracle').length,
  noEligibleData: gaps,
  bySpec: Object.fromEntries([...new Set(rows.map((r) => r.spec))].sort().map((s) => [s, rows.filter((r) => r.spec === s).length])),
};
mkdirSync(join(REPO, 'reports/campaign'), { recursive: true });
writeFileSync(join(REPO, 'reports/campaign/matrix.json'), JSON.stringify({ summary, rows }, null, 1));
const md = [
  '# T&E functional coverage matrix',
  '',
  `Generated ${summary.generated} from \`app/src/shell/commands.js\`, \`ribbon-data.js\` and \`build/campaign/corpus.json\`.`,
  '',
  `Commands ${summary.commands}; implemented ${summary.implemented ?? 'unknown (run tests/campaign/c00-registry)'}; oracle-checked ${summary.oracleChecked}; with no eligible corpus data ${gaps.length}.`,
  '',
  '| Command | Label | REQ | Rel | Spec | Context | Impl | Data items | Check |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| \`${r.id}\` | ${r.label.replace(/\|/g, '\\|')} | ${r.req} | ${r.rel} | ${r.spec} | ${r.context.join(', ') || '—'} | ${r.implemented === null ? '?' : r.implemented ? 'yes' : 'stub'} | ${r.dataCount} | ${r.oracle ?? 'smoke'} |`),
];
writeFileSync(join(REPO, 'reports/campaign/matrix.md'), `${md.join('\n')}\n`);
console.log(JSON.stringify({ ...summary, placeholders: summary.placeholders?.length ?? null, unplaced: summary.unplaced.length, noEligibleData: gaps.length }, null, 1));
