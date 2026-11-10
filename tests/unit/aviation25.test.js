// REQ-GAP-74 flight planning (app/src/analysis/flight-plan.js) against GeographicLib. The
// end-to-end checks are in tests/e2e/25-aviation.spec.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import geodesic from 'geographiclib-geodesic';
import { legTable, terrainProfile, toKml, toGpx, planFromJson, planFromPoints, planProblems, fitLegs, FT, NM, KT } from '../../app/src/analysis/flight-plan.js';
import { designator } from '../../app/src/analysis/obstruction.js';
import { voidNoData } from '../../app/src/layers/terrain.js';

const G = geodesic.Geodesic.WGS84;
const geod = {
  inverse: (a, b, c, d) => {
    const r = G.Inverse(a, b, c, d);
    return { distance: r.s12, azi1: r.azi1, azi2: r.azi2 };
  },
  direct: (a, b, az, s) => {
    const r = G.Direct(a, b, az, s);
    return { lat: r.lat2, lon: r.lon2 };
  },
};

const plan = () => ({
  name: 'TEST',
  waypoints: [
    { name: 'KVGT', lat: 36.2107, lon: -115.1944 },
    { name: 'APEX', lat: 36.4, lon: -114.95 },
    { name: 'MESQ', lat: 36.8, lon: -114.06 },
  ],
  legs: [
    { alt: 6500 * FT, speed: 120 * KT },
    { alt: 9500 * FT, speed: 140 * KT },
  ],
  clearance: 1000 * FT,
  departure: '2026-11-03T15:00:00.000Z',
});

describe('REQ-GAP-74 legs and profile', () => {
  it('leg distance, course and time match GeographicLib', () => {
    const p = plan();
    const r = legTable(p, geod);
    // A hand check: leg 1 by Vincenty-free GeographicLib in the test, computed here independently.
    const a = G.Inverse(36.2107, -115.1944, 36.4, -114.95);
    expect(r.legs[0].distance).toBeCloseTo(a.s12, 6);
    expect(r.legs[0].course).toBeCloseTo((a.azi1 + 360) % 360, 9);
    expect(r.legs[0].time).toBeCloseTo(a.s12 / (120 * KT), 6);
    expect(r.legs[1].cumTime).toBeCloseTo(r.legs[0].time + r.legs[1].distance / (140 * KT), 6);
    expect(r.legs[1].eta).toBe(new Date(Date.parse(p.departure) + r.legs[1].cumTime * 1000).toISOString());
    expect(r.distance / NM).toBeGreaterThan(50);
  });

  it('clearance warnings against a terrain function', () => {
    const p = plan();
    // A 2 500 m (8 202 ft) ridge across leg 2 near 36.6 N, flat 600 m elsewhere; no terrain east of 114.3 W.
    const ground = (lat, lon) => (lon > -114.3 ? NaN : Math.abs(lat - 36.6) < 0.01 ? 2500 : 600);
    const r = terrainProfile(p, geod, ground, { step: 50 });
    const w = r.warnings;
    // Leg 1 at 6 500 ft over 600 m (1 969 ft): 4 531 ft clear. Leg 2 at 9 500 ft over the ridge:
    // 1 298 ft above it, more than the 1 000 ft minimum: no warning, but part of leg 2 has no terrain.
    // A 2 700 m (8 858 ft) ridge leaves 642 ft (a clearance warning); 3 000 m pierces the leg.
    expect(w.filter((x) => x.kind !== 'nodata')).toEqual([]);
    expect(r.legs[0].minClearance).toBeCloseTo(6500 * FT - 600, 6);
    expect(r.legs[1].minClearance).toBeCloseTo(9500 * FT - 2500, 6);
    expect(w.find((x) => x.kind === 'nodata')?.leg).toBe(1);
    const r2 = terrainProfile(p, geod, (lat, lon) => (Math.abs(lat - 36.6) < 0.01 ? 2700 : 600), { step: 50 });
    expect(r2.warnings.map((x) => [x.leg, x.kind])).toEqual([[1, 'clearance']]);
    expect(r2.warnings[0].clearance).toBeCloseTo(9500 * FT - 2700, 6);
    const r3 = terrainProfile(p, geod, (lat) => (Math.abs(lat - 36.6) < 0.01 ? 3000 : 600), { step: 50 });
    expect(r3.warnings.map((x) => [x.leg, x.kind])).toEqual([[1, 'terrain']]);
    // The ridge is found where it is: the warning's latitude is within 0.01° of 36.6.
    expect(Math.abs(r3.warnings[0].lat - 36.6)).toBeLessThan(0.0101);
  });

  it('refuses incomplete plans by name and fits legs to waypoints', () => {
    expect(planProblems({ waypoints: [{ lat: 1, lon: 1 }], legs: [] }).map((x) => x.src)).toContain('A route needs at least two waypoints');
    const p = plan();
    p.legs[1].speed = 0;
    expect(planProblems(p).map((x) => x.src)).toEqual(['Leg {n} needs a speed above zero']);
    expect(fitLegs(p.waypoints.concat([{ lat: 37, lon: -114 }]), p.legs).length).toBe(3);
  });

  it('REG-164 the refusals are in the extracted catalogue, so they can be translated', () => {
    const keys = new Set(JSON.parse(readFileSync('app/src/i18n/catalog/en.json', 'utf8')).messages.map((m) => m.key));
    const bad = { waypoints: [{ lat: 99, lon: 0 }, { lat: 1, lon: 1 }], legs: [{ speed: 0, alt: NaN }, {}] };
    const srcs = [...planProblems(bad), ...planProblems({ waypoints: [], legs: [] })].map((x) => x.src);
    expect(new Set(srcs).size).toBe(5);
    for (const s of srcs) expect(keys.has(s), s).toBe(true);
  });

  it('KML and GPX carry the waypoints, altitudes and speeds and read back', () => {
    const p = plan();
    const kml = toKml(p);
    expect(kml).toMatch(/<altitudeMode>absolute<\/altitudeMode><coordinates>-115\.19440000,36\.21070000,1981\.20 -114\.95000000,36\.40000000,1981\.20 -114\.95000000,36\.40000000,2895\.60 -114\.06000000,36\.80000000,2895\.60<\/coordinates>/);
    const own = kml.match(/<Data name="gw:flightplan"><value>(.*?)<\/value>/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const back = planFromJson(own);
    expect(back.waypoints.map((w) => w.name)).toEqual(['KVGT', 'APEX', 'MESQ']);
    expect(back.legs[1].alt).toBeCloseTo(9500 * FT, 2);
    const gpx = toGpx(p);
    expect((gpx.match(/<rtept /g) ?? []).length).toBe(3);
    expect(gpx).toMatch(/<rtept lat="36\.40000000" lon="-114\.95000000"><ele>2895\.60<\/ele><name>APEX<\/name><extensions><gw:speed>72\.022<\/gw:speed>/);
    // GPX's convention read back: leg i takes point i's elevation and speed.
    const q = planFromPoints('R', [{ lat: 1, lon: 1, ele: 100, speed: 50 }, { lat: 1.1, lon: 1.1, ele: 200, speed: NaN }, { lat: 1.2, lon: 1.2, ele: NaN }], { alt: 10, speed: 20 });
    expect(q.legs).toEqual([{ alt: 100, speed: 50 }, { alt: 200, speed: 20 }]);
    expect(planFromJson('{"format":"other"}')).toBeNull();
    expect(planFromJson('not json')).toBeNull();
  });

  it('runway designators from true bearings', () => {
    expect(designator(93)).toBe('09/27');
    expect(designator(4)).toBe('36/18');
    expect(designator(184)).toBe('18/36');
    expect(designator(355)).toBe('36/18');
    expect(designator(266)).toBe('27/09');
  });
});

describe('voidNoData (Use as Terrain)', () => {
  it('voids a tag Float32 holds exactly, as the DFC2018 DSM declares it', () => {
    const nd = 1.701410009187828e38;
    expect(Math.fround(nd)).toBe(nd);
    expect([...voidNoData(Float32Array.of(12.5, nd, 40), nd)]).toEqual([12.5, NaN, 40]);
  });

  it('voids a tag Float32 cannot hold exactly, as GDAL writes one', () => {
    const nd = Number('1.7014100000000001e+38');
    expect(Math.fround(nd)).not.toBe(nd);
    expect([...voidNoData(Float32Array.of(12.5, nd, 40), nd)]).toEqual([12.5, NaN, 40]);
  });

  it('leaves a grid alone when no value is declared, or NaN is', () => {
    for (const nd of [null, undefined, NaN]) expect([...voidNoData(Float32Array.of(0, -32768, 1e30), nd)]).toEqual([0, -32768, 1e30].map(Math.fround));
  });

  it('keeps integer tags, and a neighbour one step from the value', () => {
    expect([...voidNoData(Float32Array.of(-32768, -32767, 0), -32768)]).toEqual([NaN, -32767, 0]);
    expect([...voidNoData(Float32Array.of(0, 1), 0)]).toEqual([NaN, 1]);
  });
});
