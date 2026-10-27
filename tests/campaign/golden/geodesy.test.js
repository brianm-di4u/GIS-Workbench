// TE-C04 accuracy: the shipped core bundle against an independent truth set made by
// build/campaign/oracles/geodesy.py — UTM/UPS from PROJ (pyproj), geodesics and areas from
// GeographicLib (Python), on a deterministic global set that includes zone edges, the
// Norway/Svalbard exceptions, the UPS caps and every corpus raster centre.
// REQ-GEO-01..06, AT-03.x (10 km within 1 mm, 1 km² within 0.1 %), AT-05.x (MGRS truncation).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { built, loadCore } from '../../golden/wasm.js';
import { CORPUS } from '../../../build/campaign/corpus-lib.mjs';

const TRUTH = join(CORPUS, '_truth', '_geodesy.json');
const have = built && existsSync(TRUTH);

describe.skipIf(!have)('TE-C04 geodesy vs PROJ/GeographicLib truth', () => {
  let core, T;
  beforeAll(() => {
    core = loadCore();
    T = JSON.parse(readFileSync(TRUTH, 'utf8'));
  });

  it('REQ-GEO-06 UTM/UPS zone and easting/northing within 1 mm of PROJ', () => {
    const bad = [];
    for (const p of T.utm) {
      let r;
      try {
        r = core.utm(p.lat, p.lon);
      } catch (e) {
        bad.push(`${p.lat},${p.lon}: ${e.message}`);
        continue;
      }
      if (r.zone !== p.zone || r.north !== p.north) bad.push(`${p.lat},${p.lon}: zone ${r.zone}${r.north ? 'N' : 'S'} vs ${p.zone}${p.north ? 'N' : 'S'}`);
      else if (Math.abs(r.easting - p.easting) > 1e-3 || Math.abs(r.northing - p.northing) > 1e-3) bad.push(`${p.lat},${p.lon}: Δe ${(r.easting - p.easting).toExponential(2)} Δn ${(r.northing - p.northing).toExponential(2)}`);
    }
    expect(bad.slice(0, 20), `${bad.length} of ${T.utm.length} points off`).toEqual([]);
  });

  it('REQ-GEO-06 AT-05.x MGRS round trip: the point lies in the truncated 1 m cell it names', () => {
    const bad = [];
    for (const p of T.utm.filter((x) => x.zone !== 0)) {
      const s = core.mgrs(p.lat, p.lon, 5);
      const c = core.mgrsToLatLon(s);
      const u = core.utm(c.lat, c.lon, p.zone);
      const e = p.easting - u.easting;
      const n = p.northing - u.northing;
      // Truncation + reverse-to-centre (gw-geodesy grids.rs): the point is within ±0.5 m of the cell centre.
      if (!(Math.abs(e) <= 0.5 + 1e-6 && Math.abs(n) <= 0.5 + 1e-6)) bad.push(`${s}: offset e ${e.toFixed(4)} n ${n.toFixed(4)}`);
    }
    expect(bad.slice(0, 20), `${bad.length} cells`).toEqual([]);
  });

  it('REQ-GEO-05 AT-03.x geodesic inverse within 1 µm of GeographicLib', () => {
    const bad = T.geodesics.filter((g) => Math.abs(core.inverse(g.p1[0], g.p1[1], g.p2[0], g.p2[1]).distance - g.s12) > 1e-6);
    expect(bad.length).toBe(0);
  });

  it('REQ-GEO-05 AT-03.x polygon area within 0.1 % (in practice 1e-9) of GeographicLib', () => {
    let worst = 0;
    for (const p of T.polygons) {
      const r = core.polygonArea(p.ring);
      worst = Math.max(worst, Math.abs(Math.abs(r.area) - p.area) / p.area);
    }
    expect(worst).toBeLessThan(1e-3);
  });
});
