// Assign CRS for LAS and LAZ (REQ-LDR-14, REG-029, SDP-2.7 §4.7): lasCrs() takes a CRS the user
// gives in place of the file's, with its units, and a TE-015-shaped header (EPSG:4326 over
// X 1–226, Y 1–100) is placed by it. The lattice it builds agrees with proj4js point by point.
import { describe, it, expect } from 'vitest';
import proj4 from 'proj4';
import { lasCrs, buildLattice, metresPerUnit } from '../../app/src/formats/las.js';
import { crsOf } from '../../app/src/geo/crs.js';

// The TE-015 file (laspy simple1_4.las): geographic keys over coordinates that cannot be degrees.
const te015 = { min: [1, 1, 44], max: [226, 100, 254], geoKeys: [[1024, 2], [2048, 4326]] };
const noCrs = { min: [545952.136, 3817161.233, 634.9], max: [546454.911, 3817663.432, 919.9] };

describe('LAS CRS', () => {
  it('TE-015 falls back to the local frame and says how to place it', () => {
    const c = lasCrs(te015, null, null);
    expect(c.local).toBe(true);
    expect(c.assigned).toBe(null);
    expect(c.warnings.join(' ')).toMatch(/not valid longitudes and latitudes/);
    expect(c.warnings.join(' ')).toMatch(/Assign CRS/);
  });

  it('an assigned CRS replaces the file’s: TE-015 in UTM 11N, heights HAE', () => {
    const c = lasCrs(te015, null, null, { epsg: 32611 });
    expect(c.local).toBe(false);
    expect(c.label).toBe('EPSG:32611');
    expect(c.assigned).toEqual({ epsg: 32611, vertical: 'hae' });
    expect([c.hUnit, c.vUnit, c.vertical]).toEqual([1, 1, 'hae']);
    expect(c.warnings.join(' ')).not.toMatch(/local metric frame|not valid longitudes/);
  });

  it('an assigned CRS also replaces a CRS the file states, with the vertical given', () => {
    const wkt = 'PROJCS["WGS 84 / UTM zone 12N"]';
    const c = lasCrs(noCrs, wkt, { hEpsg: 32612, horizontal: wkt }, { epsg: 32611, vertical: 'egm96' });
    expect(c.label).toBe('EPSG:32611');
    expect(c.vertical).toBe('egm96');
  });

  it('US-feet CRSs scale heights by the same unit', () => {
    const c = lasCrs(noCrs, null, null, { epsg: 2229, vertical: 'egm96' });
    expect(c.hUnit).toBeCloseTo(1200 / 3937, 12);
    expect(c.vUnit).toBeCloseTo(1200 / 3937, 12);
    expect(metresPerUnit('+proj=tmerc +units=ft')).toBe(0.3048);
    expect(metresPerUnit('+proj=tmerc +to_meter=0.201168')).toBe(0.201168);
    expect(metresPerUnit('EPSG:3857')).toBe(1);
  });

  it('an assigned geographic CRS over invalid degrees stays in the local frame', () => {
    expect(lasCrs(te015, null, null, { epsg: 4326 }).local).toBe(true);
  });

  it('an EPSG code outside the table is refused by name', () => {
    expect(() => lasCrs(te015, null, null, { epsg: 999999 })).toThrow(/EPSG:999999/);
  });

  it('differential: the assigned lattice places TE-015 where proj4js does', () => {
    const crs = lasCrs(te015, null, null, { epsg: 32611 });
    const { flat, origin } = buildLattice(te015, crs, () => 0);
    const [ax, ay, dx, dy, nx] = flat;
    const nodes = flat.slice(7);
    const ref = proj4(crsOf({ epsg: 32611 }).def, '+proj=longlat +datum=WGS84 +no_defs');
    let worst = 0;
    for (let j = 0; j < nx; j++)
      for (let i = 0; i < nx; i++) {
        const [lon, lat] = ref.forward([ax + i * dx, ay + j * dy]);
        const k = 3 * (j * nx + i);
        const e = (lon - origin.lon0) * origin.kx;
        const n = (lat - origin.lat0) * origin.ky;
        worst = Math.max(worst, Math.hypot(nodes[k] - e, nodes[k + 1] - n));
      }
    expect(worst).toBeLessThan(1e-6);
    // 1–226 m east of UTM 11N's false origin: about 4.5° west of −117° on the equator.
    expect(origin.lat0).toBeCloseTo(0, 3);
    expect(origin.lon0).toBeGreaterThan(-122);
    expect(origin.lon0).toBeLessThan(-121);
  });
});
