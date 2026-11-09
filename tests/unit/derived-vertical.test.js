// #86, #92, #105: a DEM the app writes keeps its vertical datum. The GeoTIFF vertical key written for
// each datum reads back as the same datum, and TIN heights convert through the datum's own grid.
import { describe, it, expect } from 'vitest';
import { geoKeys } from '../../app/src/formats/geotiff-writer.js';
import { guessVertical } from '../../app/src/features/dem.js';
import { GridEngine, VERTICALS } from '../../app/src/geo/grids.js';
import { Terrain } from '../../app/src/layers/terrain.js';

/** The GeoKeyDirectory geoKeys() writes, as the reader's {name: value} object. */
function keysOf(dir) {
  const names = { 4096: 'VerticalCSTypeGeoKey' };
  const out = {};
  for (let k = 4; k < dir.length; k += 4) if (names[dir[k]]) out[names[dir[k]]] = dir[k + 3];
  return out;
}

describe('#92 the vertical key round-trips', () => {
  // Every datum the app can label terrain with, so a new one cannot be written without a key.
  for (const vertical of ['hae', 'egm96', ...Object.keys(VERTICALS)]) {
    it(vertical, () => {
      const l = { rec: { name: 'DTM_x.tif' }, info: { meta: { geoKeys: keysOf(geoKeys({ epsg: 4326, vertical })) } } };
      expect(guessVertical(l)).toBe(vertical);
    });
  }
});

describe('#86 separations use the datum grid and its frame', () => {
  const engine = (loaded) => {
    const g = new GridEngine({});
    g.bundle = { frameTransform: (src, dst, pts) => ({ pts: pts.map((p) => [p[0], p[1], src === 'NAD83(2011)' ? -1.5 : 0]) }) };
    for (const id of loaded) g.catalogue.set(id, { id });
    g.undulations = (id, pts) => pts.map(() => (id === 'us_noaa_g2018u0' ? -30 : id === 'us_nga_egm08_25' ? 20 : NaN));
    return g;
  };
  it('NAVD88: hybrid geoid plus the NAD83 → WGS 84 height change', () => {
    expect(engine(['us_noaa_g2018u0']).separations('navd88', [[-100, 40]])).toEqual([-31.5]);
  });
  it('EGM2008: the grid alone (already WGS 84)', () => {
    expect(engine(['us_nga_egm08_25']).separations('egm2008', [[0, 0]])).toEqual([20]);
  });
  it('null when the grid is not loaded, so callers fall back to the core geoid', () => {
    expect(engine([]).separations('navd88', [[-100, 40]])).toBeNull();
    expect(engine(['us_noaa_g2018u0']).separations('egm96', [[0, 0]])).toBeNull();
  });
});

describe('#105 DEM tools convert heights as their terrain does', () => {
  // Grid: NAVD88 −31.5 m inside, NaN outside (lon > 0); core geoid (EGM96): 10 m.
  const app = { core: { undulation: () => 10 }, grids: { separations: (v, pts) => (v === 'navd88' ? pts.map(([lon]) => (lon > 0 ? NaN : -31.5)) : null) } };
  const sep = (...a) => Terrain.prototype.separations.call({ app }, ...a);
  const pts = [[-100, 40], [5, 40]];
  it('HAE: none', () => expect(sep('hae', pts)).toEqual([0, 0]));
  it('a datum with its grid loaded: the grid, and the core geoid outside it', () => expect(sep('navd88', pts)).toEqual([-31.5, 10]));
  it('a DEM registered without its grid: the core geoid, as its heights were converted', () => expect(sep('navd88', pts, false)).toEqual([10, 10]));
  it('EGM96 and a datum whose grid is not loaded: the core geoid', () => {
    expect(sep('egm96', pts)).toEqual([10, 10]);
    expect(sep('egm2008', pts)).toEqual([10, 10]);
  });
});
