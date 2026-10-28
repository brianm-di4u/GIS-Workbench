// Build build/campaign/corpus.json from the verified source lists (build/campaign/sources/*.json)
// plus the 29 already-held Research/samples folders (parsed from their SOURCE.txt). Pins already
// in corpus.json are kept, so re-running never forgets a locked SHA-256.
//
//   node build/campaign/make-corpus.mjs

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, MANIFEST, SAMPLES, fmtBytes } from './corpus-lib.mjs';
import { roleOf } from './make-corpus-roles.mjs';

const BUDGET = 24 * 2 ** 30; // raised from 20 GiB for the 2026-10-27 supplemental data (sources/supplemental.json)

// Research/samples folder → [area, format, feeds]
const HELD = {
  'dem-derived-s35w059': ['dem', 'GeoTIFF/COG float32 + DTED1', ['ingest', 'dem', 'dem.save']],
  'dted-gdal': ['dem', 'DTED0/1', ['ingest', 'dem']],
  'envi-hsi-indian-pines': ['hsi', 'ENVI BSQ', ['ingest', 'msi', 'msi.accuracy']],
  'geotiff-gdal-small': ['eo', 'GeoTIFF', ['ingest', 'display']],
  'geotiff-wv3-rpc-cog': ['eo', 'GeoTIFF/COG RPC', ['ingest', 'sensor-model']],
  'gpkg-gdal-raster-tiles': ['raster', 'GeoPackage tiles', ['ingest']],
  'hsi-indian-pines': ['hsi', 'GeoTIFF 220-band', ['ingest', 'msi']],
  'jpeg-png-worldfile': ['eo', 'JPEG/PNG + world file', ['ingest']],
  'kml-iceye-footprint': ['vector', 'KML', ['vector', 'ingest']],
  'lidar-las-laz-copc': ['lidar', 'LAS/LAZ/COPC', ['lidar', 'ingest']],
  'mpegts-klv-synthetic': ['fmv', 'MPEG-TS/KLV (synthetic)', ['fmv']],
  'msi-spacenet2-wv3': ['eo', 'GeoTIFF 8-band', ['ingest', 'msi']],
  'nitf-gdal-autotest-small': ['nitf', 'NITF2.1/NSIF', ['ingest']],
  'nitf-gdal-rset': ['nitf', 'NITF R-set', ['ingest']],
  'nitf-jitc-bitdepth': ['nitf', 'NITF2.x', ['ingest']],
  'nitf-jitc-imode-bprs': ['nitf', 'NITF2.x', ['ingest']],
  'nitf-jitc-jpeg-c3': ['nitf', 'NITF C3', ['ingest']],
  'nitf-jitc-masked-nm': ['nitf', 'NITF NM', ['ingest']],
  'nitf-jitc-multiseg-graphics': ['nitf', 'NITF multi-segment + CGM', ['ingest', 'annotate']],
  'nitf-jitc-vq-cadrg': ['nitf', 'NITF C4 VQ', ['ingest']],
  'nitf-ntb-j2k-p0_01': ['nitf', 'NITF C8', ['ingest']],
  'nitf-wv3-mvs-stereo-chips': ['eo', 'NITF2.1 RPC00B', ['ingest', 'sensor-model', 'stereo']],
  'nsif-jitc': ['nitf', 'NSIF1.0', ['ingest']],
  'sicd-sidd-xml-iceye': ['sar', 'SICD/SIDD XML', ['sar']],
  'sicd-umbra-chip': ['sar', 'SICD1.3/NITF2.1', ['ingest', 'sar']],
  'sidd-umbra': ['sar', 'SIDD/NITF2.1', ['ingest', 'sar']],
  'srtm-hgt-s35w059': ['dem', 'SRTM HGT', ['ingest', 'dem']],
  'vector-fx12-synthetic': ['vector', 'GeoJSON/GPKG/KML/KMZ/SHP (synthetic)', ['vector']],
  'vector-naturalearth-110m': ['vector', 'Shapefile', ['vector']],
};


function parseSource(dir) {
  const t = readFileSync(join(SAMPLES, dir, 'SOURCE.txt'), 'utf8');
  const field = (k) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(t)?.[1]?.trim() ?? '';
  const files = [];
  const re = /^ {2}- (\S+)\s+(\d+) bytes\s+sha256 ([0-9a-f]{64})(?:\r?\n\s+from (\S+))?/gm;
  for (let m; (m = re.exec(t)); ) files.push({ name: m[1], url: m[4] ?? null, bytes: Number(m[2]), sha256: m[3], role: roleOf(m[1]) });
  const [area, format, feeds] = HELD[dir] ?? ['other', '?', ['ingest']];
  return {
    id: `rs-${dir}`, origin: 'research-samples', dir, area, title: field('What it is').slice(0, 200), source: field('Source URL').split(/[ ,]/)[0],
    landing: field('Source URL'), licence: field('Licence'), attribution: field('Attribution'), tier: 'A', format, profile: '', files, sign: null, notes: '', feeds,
  };
}

const old = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { items: [] };
const pins = new Map(old.items.flatMap((it) => it.files.filter((f) => f.sha256).map((f) => [`${it.id}/${f.name}`, f])));
// Files fetch.mjs added by unpacking an archive ("from") are not in the source lists: carry them over.
const extracted = new Map(old.items.map((it) => [it.id, it.files.filter((f) => f.from)]));

const items = readdirSync(SAMPLES).filter((d) => existsSync(join(SAMPLES, d, 'SOURCE.txt'))).map(parseSource);
const srcDir = join(HERE, 'sources');
for (const f of readdirSync(srcDir).filter((x) => x.endsWith('.json')).sort()) {
  for (const it of JSON.parse(readFileSync(join(srcDir, f), 'utf8'))) {
    it.origin ??= 'download';
    it.files ??= [];
    for (const file of it.files) {
      file.role ??= roleOf(file.name);
      const p = pins.get(`${it.id}/${file.name}`);
      if (p) Object.assign(file, { sha256: p.sha256, bytes: p.bytes, ...(['archive', 'test-vector', 'library'].includes(p.role) ? { role: p.role } : {}) });
      else if (file.extract) file.role = file.role === 'archive' ? 'archive' : file.role;
    }
    for (const x of extracted.get(it.id) ?? []) if (!it.files.some((f) => f.name === x.name)) it.files.push(x);
    items.push(it);
  }
}
const ids = new Set();
for (const it of items) {
  if (ids.has(it.id)) throw new Error(`duplicate corpus id ${it.id}`);
  ids.add(it.id);
}
const tierA = items.filter((i) => i.tier === 'A' && i.origin === 'download').flatMap((i) => i.files).reduce((s, f) => s + (f.bytes ?? 0), 0);
writeFileSync(MANIFEST, `${JSON.stringify({ version: 1, budgetBytes: BUDGET, generated: new Date().toISOString(), items }, null, 1)}\n`);
const by = {};
for (const it of items) by[it.area] = (by[it.area] ?? 0) + 1;
console.log(`${items.length} items (${Object.entries(by).map(([a, n]) => `${a} ${n}`).join(', ')}); tier-A downloads ${fmtBytes(tierA)} of ${fmtBytes(BUDGET)}`);
