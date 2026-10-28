// Field-data items (tier U, phase F): imagery a user supplied in Research/Additional Data Samples.
// The originals are referenced in place (origin "field-data"); ZIP packages are also unpacked into
// TE-corpus/<id>/ (origin "field-extract") so the campaign tests both the archive and its contents.
// Writes sources/field.json; then run make-corpus.mjs and fetch.mjs --verify --lock --only=<field ids>.
//
//   node build/campaign/field.mjs [--extract]
//     --extract  unpack the archives (bsdtar; refuses absolute and ../ paths); nested reef ZIPs are
//                unpacked into a folder named after them and removed, shapefile ZIPs are kept whole

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HERE, CORPUS, FIELD } from './corpus-lib.mjs';
import { roleOf } from './make-corpus-roles.mjs';

const args = new Set(process.argv.slice(2));
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const listFiles = (root, from) =>
  walk(root)
    .filter((p) => !/(^|[\\/])(SOURCE\.txt|Thumbs\.db)$/i.test(p))
    .map((p) => ({ name: relative(root, p).replace(/\\/g, '/'), url: null, bytes: statSync(p).size, sha256: null, role: roleOf(p), ...(from ? { from } : {}) }));

const TEST_ONLY = 'Commercial licence held by the supplying user; test use only (OD-09): never bundled, published or used in marketing';
const common = { source: 'GIS Workbench user (field data, 2026-10-27)', landing: null, tier: 'U', notes: '' };

// [id, dir under FIELD, area, title, licence, attribution, format, profile, feeds]
const HELD = [
  ['field-phr-millerovo', 'Digital Globe Imagery/Millerovo', 'eo', 'Pléiades 1A/1B PMS ortho, Millerovo (RU), four dates Jan–Apr 2017 (folder is labelled Digital Globe)', TEST_ONLY, 'Pléiades © CNES 2017, Distribution Airbus DS', 'GeoTIFF', '13375×12835 RGB u8, uncompressed strips, no overviews, UTM 38N', ['ingest', 'display', 'change', 'compare', 'products']],
  ['field-dg-panama', 'Digital Globe Imagery/Panama', 'eo', 'DigitalGlobe ortho mosaic, Panama, 3×4 tile set (R1C1…R3C4)', TEST_ONLY, '© DigitalGlobe', 'GeoTIFF tile set', '≤16384² RGB, JPEG/YCbCr 512-px tiles, no overviews, EPSG:4326', ['ingest', 'display', 'mosaic', 'products', 'perf']],
  ['field-dg-spratly-zip', 'Digital Globe Imagery', 'eo', 'DigitalGlobe NextView deliveries, Spratly Islands (West, Subi, Mischief Reef 2014–15), as delivered: ZIP of 15 reef/date ZIPs', TEST_ONLY + ' (NextView licence, see NEXTVIEW.TXT)', '© DigitalGlobe, NextView licence', 'ZIP (nested ZIP of GeoTIFF tiles + shapefile ZIPs)', '1.5 GB stored outer ZIP', ['ingest', 'zip'], ['Spratly Islands.zip']],
  ['field-phr-dimap-zip', 'Pleiades', 'eo', 'Pléiades 1B PMS ortho DIMAP package (E131 N43, 2018-04-21), as delivered: ZIP', TEST_ONLY, 'Pléiades © CNES 2018, Distribution Airbus DS', 'ZIP (DIMAP v2 package)', '388 MB ZIP, 654 MB deflated GeoTIFF + TFW + DIMAP XML + GML masks', ['ingest', 'zip']],
  ['field-intermap-sar', 'Intermap SAR', 'sar', 'Intermap airborne X-band SAR ortho intensity, HH / VH / VV polarisations (tile m4817p37s5)', TEST_ONLY, '© Intermap Technologies', 'GeoTIFF float32', '12000×6227 f32, one band per polarisation, uncompressed strips, EPSG:4326', ['ingest', 'display', 'msi', 'sar-intensity']],
  ['field-mrsid-hamilton', 'Hamilton_2018_rgb_20x-002', 'eo', 'OSIP 2018 Hamilton County (Ohio) 0.5 ft RGB orthoimagery, countywide MrSID mosaic', 'Public domain (State of Ohio OGRIP, FGDC metadata)', 'State of Ohio Office of Information Technology, OGRIP', 'MrSID + .sdw + FGDC XML', '10.7 GB MrSID, Ohio State Plane South ftUS', ['ingest', 'mrsid']],
  ['field-mrsid-stlouis', 'StLouisCity-003', 'eo', 'St. Louis City (MO) RGB orthomosaic, MrSID MG3 (GeoExpress 9.1) with GDAL PAM GeoKeys', TEST_ONLY, 'Unknown producer (client delivery)', 'MrSID MG3 + .sdw + .aux.xml', '2.6 GB MrSID, NAD83(2011) Missouri East ftUS (user-defined GeoKeys)', ['ingest', 'mrsid']],
];

const items = [];
for (const [id, dir, area, title, licence, attribution, format, profile, feeds, only] of HELD) {
  const root = join(FIELD, dir);
  let files = only ? only.map((n) => ({ name: n, url: null, bytes: statSync(join(root, n)).size, sha256: null, role: 'primary' })) : listFiles(root);
  if (id === 'field-phr-dimap-zip') files = files.map((f) => ({ ...f, role: 'primary' }));
  items.push({ id, area, title, ...common, licence, attribution, origin: 'field-data', dir, format, profile, files, feeds });
}

// Unpacked copies of the packages.
function untar(archive, dest) {
  mkdirSync(dest, { recursive: true });
  execFileSync(TAR, ['-xf', archive, '-C', dest], { stdio: 'inherit' });
}
const spratlyZip = join(FIELD, 'Digital Globe Imagery', 'Spratly Islands.zip');
const spratlyX = join(CORPUS, '_field-spratly');
const dimapZip = join(FIELD, 'Pleiades', readdirSync(join(FIELD, 'Pleiades')).find((n) => n.endsWith('.zip')));
if (args.has('--extract')) {
  untar(spratlyZip, spratlyX);
  for (const z of walk(spratlyX).filter((p) => /Reef \d{8}\.zip$/i.test(p))) {
    untar(z, z.replace(/\.zip$/i, ''));
    unlinkSync(z);
  }
  untar(dimapZip, join(CORPUS, 'field-phr-dimap'));
}

// Reef/date folders: from the unpacked archive during --extract, afterwards from TE-corpus itself.
const reefRoot = join(spratlyX, 'Spratly Islands');
const reefs = existsSync(reefRoot)
  ? readdirSync(reefRoot).filter((n) => statSync(join(reefRoot, n)).isDirectory())
  : readdirSync(CORPUS).filter((n) => /^field-dg-spratly-.+-\d{8}$/.test(n)).map((n) => n.replace(/^field-dg-spratly-(.+)-(\d{8})$/, (_, r, d) => `${r.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} ${d}`));
for (const reef of reefs.sort()) {
  const [, name, ymd] = /^(.*) (\d{8})$/.exec(reef);
  const id = `field-dg-spratly-${name.toLowerCase().replace(/\s+/g, '-')}-${ymd}`;
  const dest = join(CORPUS, id);
  if (args.has('--extract')) {
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(join(reefRoot, reef))) renameSync(join(reefRoot, reef, f), join(dest, f));
  }
  if (!existsSync(dest)) continue;
  const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`;
  items.push({
    id, area: 'eo', title: `DigitalGlobe NextView ortho, ${name} (Spratly Islands) ${date}: R×C GeoTIFF tiles, browse, tile and seamline shapefiles`, ...common,
    licence: `${TEST_ONLY} (NextView licence, see NEXTVIEW.TXT)`, attribution: '© DigitalGlobe, NextView licence', origin: 'field-extract',
    format: 'GeoTIFF tile set + shapefile ZIPs', profile: `unpacked from Spratly Islands.zip / ${reef}.zip`, files: listFiles(dest, `Spratly Islands.zip/${reef}.zip`), feeds: ['ingest', 'display', 'mosaic', 'change', 'vector'],
  });
}
if (args.has('--extract')) rmSync(spratlyX, { recursive: true, force: true });
if (existsSync(join(CORPUS, 'field-phr-dimap'))) {
  items.push({
    id: 'field-phr-dimap', area: 'eo', title: 'Pléiades 1B PMS ortho DIMAP package (E131 N43, 2018-04-21), unpacked', ...common, licence: TEST_ONLY, attribution: 'Pléiades © CNES 2018, Distribution Airbus DS', origin: 'field-extract',
    format: 'DIMAP v2 (GeoTIFF + TFW + DIM XML + GML masks)', profile: 'unpacked from the delivered ZIP', files: listFiles(join(CORPUS, 'field-phr-dimap'), relative(FIELD, dimapZip).replace(/\\/g, '/')), feeds: ['ingest', 'display', 'metadata', 'vector', 'products'],
  });
}
writeFileSync(join(HERE, 'sources', 'field.json'), `${JSON.stringify(items, null, 1)}\n`);
console.log(`${items.length} field items → sources/field.json`);
