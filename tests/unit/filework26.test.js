// 2.6 filework (SCN-62, REQ-GAP-73): ICAO Annex 14 Volume I as amended by Amendment 18, Chapter
// 4 as applicable until 20 November 2030.
// * every Table 4-1 column against the independent reference, whose tables are typed apart from the
//   kernel's and which evaluates the inner surfaces on a triangle mesh;
// * hand-computed heights of the inner approach, inner transitional and balked landing surfaces,
//   cited per case;
// * Amendment 18's code 3 changes: the 110 m inner edge and the 55 m strip;
// * that the zone is reported on its own, and that the edition reaches every file written.
// Skipped when the bundle is absent; the differential also needs the gw-te environment.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { AviationBundle } from '../../app/src/wasm/aviation.js';
import { nasrAirport, encodeAirport, airportProblems, clusterGrid, obstaclesCsv, obstaclesGeoJson, obstaclesKml, surfacesKml, EDITIONS, ZONE_KINDS } from '../../app/src/analysis/obstruction.js';
const ICAO_EDITION = EDITIONS.icao;

const wasmPath = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_aviation.wasm');
  } catch {
    return null;
  }
})();
const haveWasm = !!wasmPath && existsSync(wasmPath);
const B = haveWasm ? new AviationBundle(new WebAssembly.Module(readFileSync(wasmPath))) : null;
const PY = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/python.exe';
const havePy = existsSync(PY);

const FX = resolve('fixtures/fx25/aviation');
const T = { base: readFileSync(join(FX, 'APT_BASE.csv'), 'latin1'), rwy: readFileSync(join(FX, 'APT_RWY.csv'), 'latin1'), end: readFileSync(join(FX, 'APT_RWY_END.csv'), 'latin1') };

// WGS 84 positions along a meridian: a meridian is a geodesic, so a runway on one is exactly the
// centre line and its extension.
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
function offset(lat, lon, north, east) {
  const m = (lat * Math.PI) / 180 + north / 2 / A;
  const M = (A * (1 - E2)) / Math.sqrt(1 - E2 * Math.sin(m) ** 2) ** 3;
  const lat1 = lat + ((north / M) * 180) / Math.PI;
  const p = (lat1 * Math.PI) / 180;
  const N = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  return [lat1, lon + ((east / (N * Math.cos(p))) * 180) / Math.PI];
}

function runway({ lat = 36, lon = -115, len = 3000, icao = [2, 2], code = 4, elev = [100, 100], apElev = 100, disp = [0, 0], thrElev = [null, null], approach = [true, true], takeoff = [true, true] } = {}) {
  const [latB] = offset(lat, lon, len, 0);
  const end = (k, la, id) => ({ id, lat: la, lon, elev: elev[k], p77: 'C', icao: icao[k], disp: disp[k], thrElev: thrElev[k], clearway: 0, approach: approach[k], takeoff: takeoff[k] });
  return { ident: 'SYN', elev: apElev, runways: [{ id: '18/36', length: len, paved: true, code, ends: [end(0, lat, '36'), end(1, latB, '18')] }] };
}

const at = (ap, s, t) => offset(ap.runways[0].ends[0].lat, ap.runways[0].ends[0].lon, s, t);
function limits(ap, pts, opts) {
  const def = encodeAirport(ap, 'icao', opts);
  const kinds = B.surfaces(def).surfaces.map((x) => x.kind);
  const r = B.points64(def, Float64Array.from(pts.flatMap(([s, t]) => at(ap, s, t))));
  return pts.map((_, k) => ({ low: r.limit[k], lowKind: kinds[r.sid[k]], zone: r.zoneLimit[k], zoneKind: kinds[r.zoneSid[k]] }));
}

describe.skipIf(!haveWasm)('REQ-GAP-73 Amendment 18, code 3 non-instrument', () => {
  const ap = runway({ icao: [0, 0], code: 3, elev: [50, 50], apElev: 50, takeoff: [false, false] });

  it('the inner edge is 110 m and the strip 55 m each side', () => {
    const cases = [
      // [s, t, height, kind, citation]
      [1500, 54, 50, 'strip', '§3.4.5: 55 m each side'],
      [1500, 65, 50 + 10 * 0.143, 'transitional', '§3.4.5 then Table 4-1 14.3 %'],
      [-160, 64, 50 + 3.33, 'approach', 'Table 4-1: 100 m out, half-width 55 + 10 m, 3.33 %'],
      [-160, 66, 50 + 3.33 + 0.143, 'transitional', 'beyond the 65 m half-width'],
      [-60.5, 54.9, 50 + 0.5 * 0.0333, 'approach', 'the inner edge is 55 m each side'],
    ];
    const r = limits(ap, cases);
    cases.forEach(([, , z, kind, cite], k) => {
      expect(r[k].lowKind, cite).toBe(kind);
      expect(Math.abs(r[k].low - z), cite).toBeLessThan(0.01);
    });
  });

  it('codes 1, 2 and 4 keep their widths', () => {
    for (const [code, half] of [[1, 30], [2, 40], [4, 75]]) {
      const a = runway({ icao: [0, 0], code, elev: [50, 50], apElev: 50, takeoff: [false, false] });
      const r = limits(a, [[1000, half - 1], [1000, half + 1]]);
      expect(r.map((x) => x.lowKind), `code ${code}`).toEqual(['strip', 'transitional']);
    }
  });
});

describe.skipIf(!haveWasm)('REQ-GAP-73 the obstacle-free zone, hand-computed (Table 4-1 columns 9 to 11)', () => {
  it('column 10, code 4 category I', () => {
    // Level at 100 m, precision to end 36 only: inner horizontal 145 m.
    const ap = runway({ icao: [2, 1] });
    const cases = [
      [-560, 59, 110, 'innerApproach', '120 m wide; 2 % from 60 m before the threshold'],
      [-959, 0, 100 + 899 * 0.02, 'innerApproach', 'its outer end, 960 m before the threshold'],
      [-560, 90, 110 + 30 * 0.333, 'innerTransitional', '33.3 % from the side of the inner approach'],
      [900, 59, 100, 'ofzStrip', 'between the inner edges, the height of the nearest centre line point'],
      [900, 90, 100 + 30 * 0.333, 'innerTransitional', '33.3 % from 60 m off the centre line'],
      [2100, 89, 100 + 300 * 0.0333, 'balkedLanding', '1 800 m after the threshold, 3.33 %, half-width 60 + 30 m'],
      [2100, 100, 100 + 300 * 0.0333 + 10 * 0.333, 'innerTransitional', 'from the side of the balked landing surface'],
    ];
    const r = limits(ap, cases);
    cases.forEach(([, , z, kind, cite], k) => {
      expect(r[k].zoneKind, cite).toBe(kind);
      expect(Math.abs(r[k].zone - z), cite).toBeLessThan(0.01);
    });
    // Where the zone ends: 960 m before the threshold, the inner horizontal plane, its outer edge.
    const top = 60 + 45 / 0.333;
    const end = 1800 + 45 / 0.0333;
    const out = limits(ap, [[-961, 0], [900, top - 0.5], [900, top + 0.5], [end - 1, 0], [end + 1, 0]]);
    expect(out.map((x) => Number.isFinite(x.zone))).toEqual([false, true, false, true, false]);
  });

  it('column 9, code 2 category I', () => {
    const ap = runway({ icao: [2, 0], code: 2 });
    const cases = [
      [-160, 44, 102.5, 'innerApproach', '90 m wide, 2.5 %'],
      [1000, 65, 108, 'innerTransitional', '40 % from 45 m off the centre line'],
      [3059, 0, 100, 'ofzStrip', 'note c: the balked landing surface starts at the end of the strip'],
      [3160, 0, 104, 'balkedLanding', '4 %'],
    ];
    const r = limits(ap, cases);
    cases.forEach(([, , z, kind, cite], k) => {
      expect(r[k].zoneKind, cite).toBe(kind);
      expect(Math.abs(r[k].zone - z), cite).toBeLessThan(0.01);
    });
  });

  it('column 11, and a runway shorter than 1 800 m ends the strip part at its end (note d)', () => {
    const ap = runway({ icao: [3, 0], len: 1500 });
    const r = limits(ap, [[1499, 0], [1501, 0]]);
    expect(r.map((x) => x.zoneKind)).toEqual(['ofzStrip', 'balkedLanding']);
  });

  it('code letter F widens columns 10 and 11 to 140 m, and not column 9', () => {
    const wide = limits(runway({ icao: [2, 0] }), [[-500, 69], [-500, 71]], { codeF: true });
    expect(wide.map((x) => x.zoneKind)).toEqual(['innerApproach', 'innerTransitional']);
    const plain = limits(runway({ icao: [2, 0] }), [[-500, 59], [-500, 61]]);
    expect(plain.map((x) => x.zoneKind)).toEqual(['innerApproach', 'innerTransitional']);
    const code2 = limits(runway({ icao: [2, 0], code: 2 }), [[-500, 44], [-500, 46]], { codeF: true });
    expect(code2.map((x) => x.zoneKind)).toEqual(['innerApproach', 'innerTransitional']);
  });

  it('stations run from a displaced threshold, heights along a sloping runway', () => {
    const ap = runway({ icao: [2, 1], elev: [100, 106], apElev: 106, disp: [300, 0], thrElev: [100.6, null] });
    const cases = [
      [300 - 60 - 500, 0, 110.6, 'innerApproach', 'from the threshold elevation'],
      [1500, 90, 100 + 6 * 0.5 + 30 * 0.333, 'innerTransitional', 'the nearest centre line point'],
      [2400, 0, 100 + 6 * 0.7 + 300 * 0.0333, 'balkedLanding', '1 800 m after the displaced threshold'],
    ];
    const r = limits(ap, cases);
    cases.forEach(([, , z, kind, cite], k) => {
      expect(r[k].zoneKind, cite).toBe(kind);
      expect(Math.abs(r[k].zone - z), cite).toBeLessThan(0.01);
    });
  });

  it('applies to precision approaches only', () => {
    for (const icao of [[0, 0], [1, 1], [0, 1]]) {
      const ap = runway({ icao });
      expect(B.surfaces(encodeAirport(ap, 'icao')).surfaces.some((x) => ZONE_KINDS.includes(x.kind))).toBe(false);
    }
    expect(B.surfaces(encodeAirport(runway(), 'part77')).surfaces.some((x) => ZONE_KINDS.includes(x.kind))).toBe(false);
    const off = runway({ approach: [false, true] });
    expect(B.surfaces(encodeAirport(off, 'icao')).surfaces.filter((x) => ZONE_KINDS.includes(x.kind)).map((x) => x.end)).toEqual([1, 1, 1, 1]);
  });

  it('refuses what Table 4-1 does not define, by name', () => {
    const ap = runway({ icao: [3, 0], code: 2 });
    expect(airportProblems(ap, 'icao')[0].src).toMatch(/no precision category II or III column/);
    expect(airportProblems(ap, 'part77')).toEqual([]);
    expect(() => B.surfaces(encodeAirport(ap, 'icao'))).toThrow(/no precision category II or III/);
  });
});

describe.skipIf(!haveWasm)('REQ-GAP-73 the zone is reported apart from the lowest surface', () => {
  it('an object inside the strip reads against the zone as well', () => {
    // 100 m off the centre line the strip is the lowest limit at 100 m, the zone's 113.32 m. A 120 m
    // mast is 20 m above the strip, and 6.68 m above the zone, which the lowest limit cannot say.
    const ap = runway();
    const r = limits(ap, [[1500, 100]])[0];
    expect(r.lowKind).toBe('strip');
    expect(r.zoneKind).toBe('innerTransitional');
    expect(r.zone).toBeCloseTo(100 + 40 * 0.333, 6);
    const c = clusterGrid({ w: 1, h: 1, z: Float32Array.of(120), limit: Float32Array.of(r.zone), sid: Uint8Array.of(0), minPen: 0 });
    expect(c.obstacles[0].pen).toBeCloseTo(6.68, 2);
  });

  it('a mast below the zone is reported by the lowest surface only', () => {
    const r = limits(runway(), [[1500, 100]])[0];
    const z = Float32Array.of(105);
    expect(clusterGrid({ w: 1, h: 1, z, limit: Float32Array.of(r.low), sid: Uint8Array.of(0), minPen: 0 }).obstacles.length).toBe(1);
    expect(clusterGrid({ w: 1, h: 1, z, limit: Float32Array.of(r.zone), sid: Uint8Array.of(0), minPen: 0 }).obstacles.length).toBe(0);
  });

  it('grid and points return the zone only when there is one', () => {
    const ll = Float64Array.from(at(runway(), 1500, 100));
    const zoned = B.points(encodeAirport(runway(), 'icao'), ll);
    expect(zoned.zoneLimit[0]).toBeCloseTo(100 + 40 * 0.333, 3);
    const plain = B.points(encodeAirport(runway({ icao: [1, 1] }), 'icao'), ll);
    expect(plain.zoneLimit).toBeUndefined();
    const g = B.grid(encodeAirport(runway(), 'icao'), Float64Array.from([2, 1, ll[0], ll[1], 1e-4, 1e-4]), Float32Array.of(100, 100));
    expect(g.zoneLimit.length).toBe(2);
    expect(g.zoneSid.length).toBe(2);
    expect(g.limit.length).toBe(2);
  });

  it('refuses a list with more surfaces than an index holds', () => {
    const ap = runway();
    ap.runways = Array.from({ length: 19 }, () => ap.runways[0]);
    expect(() => B.surfaces(encodeAirport(ap, 'icao'))).toThrow(/254/);
  });
});

describe('REQ-GAP-73 the edition travels with the results', () => {
  const rows = [{ id: 'Z1', lat: 36, lon: -115, z: 120, limit: 113.3, pen: 6.7, surface: 'Inner transitional surface 36', posts: 1, zone: true }, { id: 'P1', lat: 36, lon: -115, z: 120, limit: 100, pen: 20, surface: 'Runway strip 18/36', posts: 1, zone: false }];

  it('names Amendment 18 and the chapter that applies', () => {
    expect(ICAO_EDITION).toBe('ICAO Annex 14 Volume I as amended by Amendment 18, Chapter 4 as applicable until 20 November 2030');
  });

  it('CSV: two columns for Annex 14, none for Part 77', () => {
    const icao = obstaclesCsv(rows, { edition: ICAO_EDITION }).split('\n');
    expect(icao[0]).toBe('id,lat,lon,top_m_orthometric,surface_m,penetration_m,penetration_ft,surface,posts_or_points,obstacle_free_zone,edition');
    expect(icao[1].endsWith(`,1,yes,"${ICAO_EDITION}"`)).toBe(true);
    expect(icao[2].includes(',1,no,')).toBe(true);
    expect(obstaclesCsv(rows).split('\n')[0]).toBe('id,lat,lon,top_m_orthometric,surface_m,penetration_m,penetration_ft,surface,posts_or_points');
  });

  it('GeoJSON and KML', () => {
    const g = JSON.parse(obstaclesGeoJson(rows, { edition: ICAO_EDITION }));
    expect(g.gisWorkbench.edition).toBe(ICAO_EDITION);
    expect(g.features[0].properties.obstacleFreeZone).toBe(true);
    expect(g.features[1].properties.obstacleFreeZone).toBeUndefined();
    expect(obstaclesKml(rows, 'x', { edition: ICAO_EDITION })).toContain(`<description>${ICAO_EDITION}</description>`);
    expect(obstaclesKml(rows, 'x')).not.toContain('Amendment');
    expect(surfacesKml({ surfaces: [], facets: [] }, [], 'x', { edition: ICAO_EDITION })).toContain(ICAO_EDITION);
  });
});

describe.skipIf(!haveWasm || !havePy)('REQ-GAP-73 differential: every Table 4-1 column against the independent reference', () => {
  // [name, airport] for the eleven columns of Table 4-1, then real runways and the awkward cases.
  // The columns run with no take-off climb: at code 3 and 4 its 2 % lies below the approach and is
  // wider, which hid a wrong inner edge from this test until a mutation run showed it.
  const col = (typ, code) => runway({ icao: [typ, typ], code, len: code === 1 ? 700 : code === 2 ? 1000 : code === 3 ? 1500 : 3000, elev: [50, 53], apElev: 53, takeoff: [false, false] });
  const cases = [
    ['with take-off climbs', runway({ icao: [0, 2], code: 3, len: 1500, elev: [50, 53], apElev: 53 })],
    ['col 2 NI code 1', col(0, 1)],
    ['col 3 NI code 2', col(0, 2)],
    ['col 4 NI code 3', col(0, 3)],
    ['col 5 NI code 4', col(0, 4)],
    ['col 6 NPA code 1', col(1, 1)],
    ['col 6 NPA code 2', col(1, 2)],
    ['col 7 NPA code 3', col(1, 3)],
    ['col 8 NPA code 4', col(1, 4)],
    ['col 9 PA-I code 1', col(2, 1)],
    ['col 9 PA-I code 2', col(2, 2)],
    ['col 10 PA-I code 3', col(2, 3)],
    ['col 10 PA-I code 4', col(2, 4)],
    ['col 11 PA-II/III code 3', col(3, 3)],
    ['col 11 PA-II/III code 4', col(3, 4)],
    ['mixed ends', runway({ icao: [2, 0], elev: [200, 204], apElev: 204 })],
    ['displaced threshold', runway({ icao: [2, 3], elev: [200, 204], apElev: 204, disp: [400, 150], thrElev: [200.6, null] })],
    ['short precision runway', runway({ icao: [2, 2], len: 1500 })],
    ['no approach or take-off beyond the far end', runway({ icao: [2, 0], approach: [true, false], takeoff: [true, false] })],
    ['code letter F', runway({ icao: [2, 3] }), { codeF: true }],
    ['datum below the runway', runway({ icao: [2, 2], elev: [150, 150], apElev: 100 })],
    ['LAS, real runways', nasrAirport(T, 'LAS')],
    ['HOU, real runways', nasrAirport(T, 'HOU')],
    ['SFO, real runways', nasrAirport(T, 'SFO')],
  ];
  for (const [name, ap, opts = {}] of cases)
    it(`${name}: agrees within 1 cm`, () => {
      const def = encodeAirport(ap, 'icao', opts);
      // Half the points near the runways, where the zone is; half over the whole model.
      const m = B.surfaces(def);
      const [s, w, n, e] = m.bbox;
      let seed = name.length * 7919 + 13;
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
      const ll = [];
      for (let k = 0; k < 16000; k++) {
        if (k % 2) ll.push([s + (n - s) * rnd(), w + (e - w) * rnd()]);
        else {
          const rw = ap.runways[(k / 2) % ap.runways.length];
          const [p, q] = rw.ends;
          const f = rnd() * 2 - 0.5;
          ll.push(offset(p.lat + (q.lat - p.lat) * f, p.lon + (q.lon - p.lon) * f, (rnd() - 0.5) * 900, (rnd() - 0.5) * 900));
        }
      }
      const r = B.points64(def, Float64Array.from(ll.flat()));
      const dir = mkdtempSync(join(tmpdir(), 'obsref26-'));
      const spec = { regime: 'icao', airport: { elev: ap.elev, codeF: !!opts.codeF, runways: ap.runways.map((rw) => ({ paved: rw.paved, code: rw.code, ends: rw.ends.map((en) => ({ lat: en.lat, lon: en.lon, elev: en.elev, p77: en.p77, icao: en.icao, disp: en.disp, thrElev: en.thrElev, approach: en.approach, takeoff: en.takeoff, clearway: en.clearway })) })) }, points: ll };
      writeFileSync(join(dir, 'in.json'), JSON.stringify(spec));
      execFileSync(PY, ['-I', resolve('tests/tools/obstruction_ref.py'), join(dir, 'in.json'), join(dir, 'out.json')], { timeout: 600000 });
      const ref = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
      const kinds = m.surfaces.map((x) => x.kind);
      const flips = (k, list) => {
        const [la, lo] = ll[k];
        const nb = [];
        for (let q = 0; q < 8; q++) nb.push(offset(la, lo, 0.5 * Math.cos((q * Math.PI) / 4), 0.5 * Math.sin((q * Math.PI) / 4)));
        return [...B.points64(def, Float64Array.from(nb.flat()))[list]].some((v) => Number.isFinite(v) !== Number.isFinite(r[list][k]));
      };
      const compare = (mine, theirs, list) => {
        let both = 0;
        let maxd = 0;
        for (let k = 0; k < ll.length; k++) {
          const a = mine[k];
          const b = theirs[k];
          if (Number.isFinite(a) && b !== null) {
            both++;
            // A step in height at a surface's edge: only a point within 0.5 m of one may differ.
            const d = Math.abs(a - b);
            if (d >= 0.01) expect(flipsHeight(k, list), `${name} ${list} point ${k} (${ll[k]}): kernel ${a}, reference ${b}`).toBe(true);
            else maxd = Math.max(maxd, d);
          } else if (Number.isFinite(a) !== (b !== null)) expect(flips(k, list), `${name} ${list} point ${k} (${ll[k]}): kernel ${a}, reference ${b}`).toBe(true);
        }
        return { both, maxd };
      };
      const flipsHeight = (k, list) => {
        const [la, lo] = ll[k];
        const nb = [];
        for (let q = 0; q < 8; q++) nb.push(offset(la, lo, 0.5 * Math.cos((q * Math.PI) / 4), 0.5 * Math.sin((q * Math.PI) / 4)));
        const v = [...B.points64(def, Float64Array.from(nb.flat()))[list]];
        const c = r[list][k];
        return v.some((x) => !Number.isFinite(x) || Math.abs(x - c) > 0.02);
      };
      const low = compare(r.limit, ref.limit, 'limit');
      const zone = compare(r.zoneLimit, ref.ofzLimit, 'zoneLimit');
      expect(low.both).toBeGreaterThan(2000);
      expect(low.maxd).toBeLessThan(0.01);
      expect(zone.maxd).toBeLessThan(0.01);
      const hasZone = ap.runways.some((rw) => rw.ends.some((en) => en.approach !== false && en.icao >= 2));
      if (hasZone) expect(zone.both, 'points in the zone').toBeGreaterThan(300);
      else expect(zone.both).toBe(0);
      // Where both name a zone surface they name the same one, away from the seams between surfaces.
      let same = 0;
      let diff = 0;
      for (let k = 0; k < ll.length; k++) {
        if (r.zoneSid[k] < 0 || ref.ofzKind[k] === null) continue;
        if (kinds[r.zoneSid[k]] === ref.ofzKind[k]) same++;
        else if (Math.abs(r.zoneLimit[k] - ref.ofzLimit[k]) > 0.01) diff++;
      }
      expect(diff).toBe(0);
      console.log(`${name}: lowest ${low.both} points, max |Δ| ${(low.maxd * 1000).toFixed(2)} mm; zone ${zone.both} points, max |Δ| ${(zone.maxd * 1000).toFixed(2)} mm, ${same} same kind`);
    }, 180000);
});
