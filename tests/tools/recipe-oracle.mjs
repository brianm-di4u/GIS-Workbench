// The library recipes' oracle cases (SDP-2.8 §4.5, tests/oracles/README.md): reading them, and
// comparing what a recipe wrote against the committed oracle outputs. Pure Node; CI never runs an
// oracle. Used by tests/e2e/28-recipe-library.spec.js (the page) and
// tests/e2e/sidecar/28-gwb-run-library.spec.js (the command line).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fromArrayBuffer } from 'geotiff';

export const ORACLES = resolve('tests', 'oracles');

/** Every case: {id, dir, case, provenance}. A recipe folder without a case.json is an error, not a skip. */
export function oracleCases() {
  return readdirSync(ORACLES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(ORACLES, e.name);
      const file = join(dir, 'case.json');
      if (!existsSync(file)) throw new Error(`tests/oracles/${e.name} has no case.json`);
      return { id: e.name, dir, case: JSON.parse(readFileSync(file, 'utf8')), provenance: JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8')) };
    });
}

/** What a COG holds, as the oracle records it (tests/tools/oracles/folder_to_cog.py describe()). */
export async function describeCog(bytes) {
  const tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const n = await tiff.getImageCount();
  const img = await tiff.getImage(0);
  const [ox, oy] = img.getOrigin();
  const [rx, ry] = img.getResolution();
  const keys = img.getGeoKeys() ?? {};
  const nodata = img.getGDALNoData();
  const planes = await img.readRasters({ interleave: false });
  const bands = [];
  for (let b = 0; b < planes.length; b++) {
    const a = planes[b];
    bands.push({ type: a.constructor.name.replace('Array', ''), nodata, sha256: createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex') });
  }
  const overviews = [];
  for (let k = 1; k < n; k++) {
    const o = await tiff.getImage(k);
    // A mask image is not an overview.
    if (!((o.fileDirectory.NewSubfileType ?? 0) & 4)) overviews.push([o.getWidth(), o.getHeight()]);
  }
  return { width: img.getWidth(), height: img.getHeight(), geotransform: [ox, rx, 0, oy, 0, ry], epsg: keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey ?? null, bands, overviews, tiled: !!img.isTiled };
}

const TYPES = { Float32: 'Float32', Float64: 'Float64', Int16: 'Int16', Uint16: 'UInt16', Uint8: 'Byte', Int32: 'Int32', Uint32: 'UInt32' };

/** The differences between a COG and its oracle record, as readable lines (empty: it matches). */
export function compareCog(got, want) {
  const out = [];
  const eq = (what, a, b) => JSON.stringify(a) !== JSON.stringify(b) && out.push(`${what}: ${JSON.stringify(a)}, oracle ${JSON.stringify(b)}`);
  eq('size', [got.width, got.height], [want.width, want.height]);
  eq('EPSG', got.epsg, want.epsg);
  // The geotransform to a millionth of a pixel: both write the same doubles, but a reader may round.
  const w = want.geotransform;
  const scale = [w[1], w[1], w[1], w[5], w[5], w[5]].map(Math.abs); // in pixels: origin and sizes alike
  const gt = got.geotransform.map((v, i) => Math.abs(v - w[i]) <= scale[i] * 1e-6);
  if (!gt.every(Boolean)) out.push(`geotransform: ${JSON.stringify(got.geotransform)}, oracle ${JSON.stringify(want.geotransform)}`);
  eq('bands', got.bands.length, want.bands.length);
  want.bands.forEach((b, i) => {
    const g = got.bands[i];
    if (!g) return;
    eq(`band ${i + 1} type`, TYPES[g.type] ?? g.type, b.type);
    eq(`band ${i + 1} no-data`, g.nodata, b.nodata);
    eq(`band ${i + 1} samples (SHA-256)`, g.sha256, b.sha256);
  });
  eq('overview sizes', got.overviews, want.overviews);
  if (!got.tiled) out.push('not tiled');
  return out;
}
