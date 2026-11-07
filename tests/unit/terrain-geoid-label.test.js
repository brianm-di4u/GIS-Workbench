// OD-2.31 (oracles): the name of a terrain says which geoid really converts its heights. The core adds
// its own geoid when a height is read, so an orthometric DEM follows a geoid pack opened after it. The
// label used to be fixed: "converted with EGM96" with the EGM2008 5′ pack in the core (every Hetch
// Hetchy run of 2.5 and 2.6), and "NAVD88 (not converted)" for heights the core did convert.
import { describe, it, expect } from 'vitest';
import { Terrain } from '../../app/src/layers/terrain.js';

function appWith({ demGeoid, grids = null } = {}) {
  const on = {};
  const core = { demGeoid, loadDem: () => 1, freeDem() {} };
  return {
    core,
    grids,
    store: { get: () => ({}) },
    on: (k, f) => (on[k] = f),
    emit(k) {
      this.emitted = [...(this.emitted ?? []), k];
    },
    fire: (k) => on[k]?.(),
  };
}

const grid = () => ({ lat0: 2, lon0: 0, dlat: 1, dlon: 1, width: 2, height: 2, heights: new Float32Array(4) });
const layer = { id: 'L', rec: { name: 'dem.tif' } };

describe('The terrain label names the geoid in use', () => {
  it('EGM96 in the core: EGM2008 heights say so, as before', () => {
    const a = appWith({ demGeoid: 'EGM96' });
    const t = new Terrain(a);
    t.addGrid(layer, grid(), { vertical: 'egm2008', label: 'GeoTIFF' });
    expect(t.entry('L').name).toBe('dem.tif (GeoTIFF, MSL EGM2008 (converted with EGM96))');
  });

  it('EGM2008 5′ in the core: not EGM96', () => {
    const a = appWith({ demGeoid: 'EGM2008' });
    const t = new Terrain(a);
    t.addGrid(layer, grid(), { vertical: 'egm2008', label: 'GeoTIFF' });
    expect(t.entry('L').name).toBe('dem.tif (GeoTIFF, MSL EGM2008 (converted with EGM2008))');
  });

  it('a geoid pack opened after the DEM changes the name of the DEM', () => {
    const a = appWith({ demGeoid: 'EGM96' });
    const t = new Terrain(a);
    t.addGrid(layer, grid(), { vertical: 'egm96', label: 'DTED' });
    expect(t.entry('L').name).toBe('dem.tif (DTED, MSL EGM96)');
    a.core.demGeoid = 'EGM2008';
    a.fire('geoid');
    expect(t.entry('L').name).toBe('dem.tif (DTED, MSL EGM96 (converted with EGM2008))');
    expect(a.emitted.filter((k) => k === 'terrain').length).toBe(2); // once for the DEM, once for the name
    a.fire('geoid');
    expect(a.emitted.filter((k) => k === 'terrain').length).toBe(2); // nothing changed, nothing sent
  });

  it('NAVD88 with no GEOID18 grid is read on the core geoid, and says so', () => {
    const a = appWith({ demGeoid: 'EGM2008' });
    const t = new Terrain(a);
    t.addGrid(layer, grid(), { vertical: 'navd88', label: 'GeoTIFF' });
    expect(t.entry('L').name).toBe('dem.tif (GeoTIFF, NAVD88 (read as EGM2008 heights))');
    expect(t.converter('navd88')).toBe('EGM2008');
  });

  it('with the grid loaded the grid names the route, and a later geoid does not change it', () => {
    const gridV = { label: 'NAVD88 → HAE by GEOID18 (us_noaa_g2018u0.tif), NAD83(2011) → WGS 84 (G2296) at 2026.85', convert: (h) => h };
    const a = appWith({ demGeoid: 'EGM96', grids: { demHeights: () => gridV, geoidFor: (v) => (v === 'navd88' ? 'GEOID18' : null) } });
    const t = new Terrain(a);
    t.addGrid(layer, grid(), { vertical: 'navd88', label: 'GeoTIFF' });
    expect(t.entry('L').name).toBe(`dem.tif (GeoTIFF, ${gridV.label})`);
    expect(t.converter('navd88')).toBe('GEOID18');
    a.core.demGeoid = 'EGM2008';
    a.fire('geoid');
    expect(t.entry('L').name).toBe(`dem.tif (GeoTIFF, ${gridV.label})`);
  });

  it('heights on the ellipsoid name no geoid', () => {
    const a = appWith({ demGeoid: 'EGM2008' });
    const t = new Terrain(a);
    t.addGrid(layer, grid(), { vertical: 'hae', label: 'GeoTIFF' });
    expect(t.entry('L').name).toBe('dem.tif (GeoTIFF, HAE)');
  });
});
