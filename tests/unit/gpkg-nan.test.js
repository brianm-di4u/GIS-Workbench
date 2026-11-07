// GeoPackage export (REQ-EXT-22): a feature without a finite position (a CSV row with no
// coordinates) is written with its attributes but kept out of the R-tree, and the layer extent
// comes from the finite features (TE 2.0.4 cross, IBTrACS: "rtree constraint failed").
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { writeGpkg } from '../../app/src/vector/gpkg.js';

const require = createRequire(import.meta.url);

describe('GeoPackage export with a no-position feature', () => {
  it('writes, indexes the finite features and keeps a finite extent', async () => {
    const initSqlJs = require('rtree-sql.js/dist/sql-wasm.js');
    const SQL = await initSqlJs({ wasmBinary: readFileSync(require.resolve('rtree-sql.js/dist/sql-wasm.wasm')) });
    const features = [
      { geom: { type: 'Point', xyz: [-80.1, 25.7, 0], parts: [0], polys: [] }, attrs: { name: 'A' } },
      { geom: { type: 'Point', xyz: [NaN, NaN, 0], parts: [0], polys: [] }, attrs: { name: 'B' } },
      { geom: { type: 'Point', xyz: [-79.5, 26.2, 0], parts: [0], polys: [] }, attrs: { name: 'C' } },
    ];
    const { bytes } = writeGpkg(SQL, [{ name: 'tracks', fields: [], features }]);
    const db = new SQL.Database(bytes);
    expect(db.exec('SELECT count(*) FROM tracks')[0].values[0][0]).toBe(3);
    expect(db.exec('SELECT count(*) FROM rtree_tracks_geom')[0].values[0][0]).toBe(2);
    const [x0, y0, x1, y1] = db.exec("SELECT min_x, min_y, max_x, max_y FROM gpkg_contents WHERE table_name = 'tracks'")[0].values[0];
    expect([x0, y0, x1, y1]).toEqual([-80.1, 25.7, -79.5, 26.2]);
  });
});
