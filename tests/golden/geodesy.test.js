// REQ-RUST-06 differential tests: the shipped `core` bundle against independent JavaScript
// oracles — GeographicLib JS (geodesics, areas), the `mgrs` package (MGRS in UTM zones) and
// egm96-universal (geoid) — over random inputs with stated tolerances. REQ-GEO-01..03,
// REQ-GEO-05 (GeographicLib geodesics and areas), REQ-GEO-06 (MGRS against the mgrs package).
import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import geographiclib from 'geographiclib-geodesic';
import * as mgrs from 'mgrs';
import { egm96ToEllipsoid } from 'egm96-universal';
import { built, loadCore, blockBytes } from './wasm.js';

const G = geographiclib.Geodesic.WGS84;
const lat = fc.double({ min: -89.9, max: 89.9, noNaN: true });
const lon = fc.double({ min: -179.9, max: 179.9, noNaN: true });

describe.skipIf(!built)('geodesy differential (core vs JS oracles)', () => {
  let core;
  beforeAll(() => (core = loadCore()));

  it('inverse geodesic: distance within 1 µm; our azimuth reaches the second point', () => {
    fc.assert(
      fc.property(lat, lon, lat, lon, (a, b, c, d) => {
        const o = G.Inverse(a, b, c, d);
        const r = core.inverse(a, b, c, d);
        expect(Math.abs(r.distance - o.s12)).toBeLessThan(1e-6);
        // Near-antipodal pairs have several shortest geodesics (mirror azimuths), so the
        // azimuth is checked by following it rather than by equality with the oracle.
        const e = G.Direct(a, b, r.azi1, r.distance);
        expect(G.Inverse(e.lat2, e.lon2, c, d).s12).toBeLessThan(1e-6);
      }),
      { numRuns: 400, seed: 42 },
    );
  });

  it('direct geodesic: end point within 1e-9°', () => {
    fc.assert(
      fc.property(lat, lon, fc.double({ min: -180, max: 180, noNaN: true }), fc.double({ min: 0, max: 1.5e7, noNaN: true }), (a, b, az, s) => {
        const o = G.Direct(a, b, az, s);
        const r = core.direct(a, b, az, s);
        expect(Math.abs(r.lat - o.lat2)).toBeLessThan(1e-9);
        expect(Math.abs(((r.lon - o.lon2 + 540) % 360) - 180)).toBeLessThan(1e-9);
      }),
      { numRuns: 400, seed: 7 },
    );
  });

  it('polygon area and perimeter within 1e-6 relative', () => {
    fc.assert(
      fc.property(fc.double({ min: -60, max: 60, noNaN: true }), fc.double({ min: -170, max: 170, noNaN: true }), fc.double({ min: 0.001, max: 2, noNaN: true }), (a, b, s) => {
        const pts = [[a, b], [a, b + s], [a + s, b + s], [a + s * 0.5, b - s * 0.3]];
        const p = G.Polygon(false);
        for (const [x, y] of pts) p.AddPoint(x, y);
        const o = p.Compute(false, true);
        const r = core.polygonArea(pts);
        expect(Math.abs(Math.abs(r.area) - Math.abs(o.area)) / Math.abs(o.area)).toBeLessThan(1e-6);
        expect(Math.abs(r.perimeter - o.perimeter) / o.perimeter).toBeLessThan(1e-9);
      }),
      { numRuns: 200, seed: 3 },
    );
  });

  it('MGRS (UTM zones): both strings decode to points within 1.5 m of each other', () => {
    fc.assert(
      fc.property(fc.double({ min: -79.5, max: 83.5, noNaN: true }), lon, (a, b) => {
        // The mgrs package does not apply the Norway/Svalbard zone exceptions.
        if (a > 55 && a < 84 && b > 0 && b < 42) return;
        const ours = core.mgrs(a, b, 5).replace(/\s+/g, '');
        const theirs = mgrs.forward([b, a], 5);
        const [x1, y1] = mgrs.toPoint(ours);
        const [x2, y2] = mgrs.toPoint(theirs);
        const d = G.Inverse(y1, x1, y2, x2).s12;
        expect(d, `${ours} vs ${theirs}`).toBeLessThan(1.5);
        const back = core.mgrsToLatLon(ours);
        expect(G.Inverse(back.lat, back.lon, a, b).s12).toBeLessThan(1.5);
      }),
      { numRuns: 400, seed: 11 },
    );
  });

  it('EGM96 undulation agrees with egm96-universal within 0.25 m (different interpolators)', () => {
    core.loadGeoid(blockBytes('data-egm96'), { kind: 0, width: 1440, height: 721 }); // the shipped grid block
    fc.assert(
      fc.property(fc.double({ min: -89, max: 89, noNaN: true }), lon, (a, b) => {
        const n = core.undulation(a, b);
        if (!Number.isFinite(n)) return;
        const o = egm96ToEllipsoid(a, b, 0);
        expect(Math.abs(n - o)).toBeLessThan(0.25);
      }),
      { numRuns: 300, seed: 5 },
    );
  });
});
