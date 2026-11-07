// REQ-GAP-16 unit tests: the grid catalogue against the pinned downloads, the datum routes
// against the catalogue, datum recognition from EPSG codes and WKT, the Datum Transform point
// parser, and the frame table generator's output being what the crate holds.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ROUTES, VERTICALS, datumKeyOf, decimalYear, parsePoints } from '../../app/src/geo/grids.js';

const cat = JSON.parse(readFileSync('build/grids-catalogue.json', 'utf8'));
const src = JSON.parse(readFileSync('build/packs-sources.json', 'utf8'));

describe('REQ-GAP-16 grid catalogue', () => {
  it('every catalogued grid is pinned (URL on cdn.proj.org, SHA-256, licence) and in exactly one pack', () => {
    const inPacks = Object.values(cat.packs).flatMap((p) => p.grids);
    expect(new Set(inPacks).size).toBe(inPacks.length);
    for (const id of Object.keys(cat.grids)) {
      expect(inPacks).toContain(id);
      const s = src.downloads.find((d) => d.id === `grid-${id}`);
      expect(s, id).toBeTruthy();
      expect(s.url).toBe(`https://cdn.proj.org/${id}.tif`);
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.licence).toMatch(/Licence: (CC-BY-4\.0|OGL-Canada-2\.0|BSD-2-Clause|Public domain|Free redistribution)/);
      const g = cat.grids[id];
      expect(['hgridshift', 'gridshift', 'vgridshift']).toContain(g.op);
      expect(g.epsg).toBeGreaterThan(1000);
      expect(g.accuracy).toBeGreaterThan(0);
    }
    expect(Object.keys(cat.packs).sort()).toEqual(['geoid-egm2008-25', 'grids-eu', 'grids-na', 'grids-oceania']);
  });

  it('every route and vertical datum names catalogued grids', () => {
    for (const [k, r] of Object.entries(ROUTES)) for (const c of r.chains) for (const g of c.grids) expect(cat.grids[g], `${k}: ${g}`).toBeTruthy();
    for (const v of Object.values(VERTICALS)) expect(cat.grids[v.grid]?.op).toBe('vgridshift');
    // NADCON5 chains end in NAD83(2011) and run in EPSG order.
    expect(ROUTES.NAD27.chains[0].grids.map((g) => cat.grids[g].epsg)).toEqual([8555, 8556, 8861, 8862, 8559]);
  });
});

describe('REQ-GAP-16 datum recognition', () => {
  it('EPSG codes', () => {
    expect(datumKeyOf({ epsg: 26717 })).toBe('NAD27');
    expect(datumKeyOf({ epsg: 32040 })).toBe('NAD27');
    expect(datumKeyOf({ epsg: 32140 })).toBe('NAD83');
    expect(datumKeyOf({ epsg: 26917 })).toBe('NAD83');
    expect(datumKeyOf({ epsg: 6339 })).toBe('NAD83(2011)');
    expect(datumKeyOf({ epsg: 27700 })).toBe('OSGB36');
    expect(datumKeyOf({ epsg: 31467 })).toBe('DHDN');
    expect(datumKeyOf({ epsg: 28355 })).toBe('GDA94');
    expect(datumKeyOf({ epsg: 7855 })).toBe('GDA2020');
    expect(datumKeyOf({ epsg: 25832 })).toBe('ETRS89');
    expect(datumKeyOf({ epsg: 4326 })).toBe(null);
    expect(datumKeyOf({ epsg: 32633 })).toBe(null);
  });
  it('WKT datum names, the specific realisations first', () => {
    expect(datumKeyOf({ wkt: 'PROJCS["NAD83(2011) / UTM zone 15N",GEOGCS["NAD83(2011)",DATUM["NAD83_National_Spatial_Reference_System_2011"' })).toBe('NAD83(2011)');
    expect(datumKeyOf({ wkt: 'GEOGCS["NAD83(HARN)",DATUM["NAD83_High_Accuracy_Reference_Network"' })).toBe('NAD83(HARN)');
    expect(datumKeyOf({ wkt: 'PROJCS["NAD_1983_StatePlane_California_V_FIPS_0405_Feet",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983"' })).toBe('NAD83');
    expect(datumKeyOf({ wkt: 'GEOGCS["NAD83(CSRS)",DATUM["NAD83_Canadian_Spatial_Reference_System"' })).toBe(null);
    expect(datumKeyOf({ wkt: 'PROJCS["OSGB 1936 / British National Grid",GEOGCS["OSGB 1936"' })).toBe('OSGB36');
    expect(datumKeyOf({ wkt: 'GEOGCS["GDA2020"' })).toBe('GDA2020');
    expect(datumKeyOf({ def: '+proj=tmerc +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +title=DHDN' })).toBe('DHDN');
  });
});

describe('REQ-GAP-16 Datum Transform input', () => {
  it('parses "lat lon [h]" lines into [lon, lat, h]', () => {
    expect(parsePoints('51.5 -0.12 45\n\n  40.0, -105.0 ')).toEqual([[-0.12, 51.5, 45], [-105, 40, 0]]);
    expect(() => parsePoints('91 0')).toThrow(/is not latitude, longitude/);
    expect(() => parsePoints('a b')).toThrow();
  });
  it('decimal years', () => {
    expect(decimalYear(new Date(Date.UTC(2020, 0, 1)))).toBe(2020);
    expect(decimalYear(new Date(Date.UTC(2021, 6, 2, 12)))).toBeCloseTo(2021.5, 3);
  });
});

describe('REQ-GAP-16 frame table', () => {
  it('frames.rs holds the generator output for every frame and no superseded operation', () => {
    const rs = readFileSync('crates/gw-geodesy/src/datum/frames.rs', 'utf8');
    for (const f of ['ITRF2020', 'ITRF2014', 'WGS 84 (G2296)', 'WGS 84 (G2139)', 'NAD83(2011)', 'GDA2020', 'ETRF2014']) expect(rs).toContain(`("${f}",`);
    // EPSG:9020 (ITRF88 to ITRF89 (1)) is superseded by EPSG:10139.
    expect(rs).not.toMatch(/\n {4}\(9020,/);
    expect(rs).toMatch(/\n {4}\(10139,/);
    expect(rs).toMatch(/\n {4}\(8970, 12, 22, false/); // ITRF2014 → NAD83(2011), coordinate frame
  });
});
