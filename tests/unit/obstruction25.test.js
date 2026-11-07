// REQ-GAP-73 airfield obstruction surfaces: the `aviation` WASM bundle (crates/gw-aviation) through
// its JS wrapper and app/src/analysis/obstruction.js.
// * hand-computed surface heights from the published formulas (14 CFR §77.19, ICAO Annex 14 Tables
//   4-1 and 4-2), cited per case;
// * NASR parsing of the fixture rows (LAS, VGT, HND, CYS, BVU, SFO, OAK, CCR) against the FAA's
//   published runway lengths and true alignments;
// * a differential test against the independent Python reference (tests/tools/obstruction_ref.py,
//   pyproj geodesics and shapely), run when the gw-te environment is present;
// * obstacle grouping on grids and point sets with hand-placed obstacles; malformed definitions refused.
// Skipped when the bundle is absent.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { AviationBundle } from '../../app/src/wasm/aviation.js';
import { nasrAirport, encodeAirport, clusterGrid, clusterPoints, airportProblems, csvRow, obstaclesCsv, surfacesKml, FT } from '../../app/src/analysis/obstruction.js';

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

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

// WGS 84 geodesy for the hand cases (independent of the kernel): positions along a runway by
// small-distance offsets on the ellipsoid (radii of curvature at the runway), adequate to a few mm
// over the distances used here.
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
function offset(lat, lon, north, east) {
  // North along the meridian (M at the mid-latitude), then east along the parallel of arrival.
  const m = (lat * Math.PI) / 180 + north / 2 / A;
  const M = (A * (1 - E2)) / Math.sqrt(1 - E2 * Math.sin(m) ** 2) ** 3;
  const lat1 = lat + ((north / M) * 180) / Math.PI;
  const p = (lat1 * Math.PI) / 180;
  const N = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  return [lat1, lon + ((east / (N * Math.cos(p))) * 180) / Math.PI];
}

/**
 * A synthetic north–south runway (a meridian is a geodesic, so the centreline and its extension are
 * exactly the meridian): end A at (lat, lon), end B `len` m north.
 */
function synthAirport({ lat = 36, lon = -115, len = 3000, cats = ['PIR', 'PIR'], icao = [2, 2], code = 4, elev = [600, 610], apElev = 610, paved = true } = {}) {
  const [latB] = offset(lat, lon, len, 0);
  const end = (la, el, c, i, id) => ({ id, lat: la, lon, elev: el, p77: c, icao: i, disp: 0, thrElev: null, clearway: 0, approach: true, takeoff: true });
  return { ident: 'SYN', elev: apElev, runways: [{ id: '18/36', length: len, paved, code, ends: [end(lat, elev[0], cats[0], icao[0], '36'), end(latB, elev[1], cats[1], icao[1], '18')] }] };
}

/** Limits at (station s m north of end A, offset t m east) of a synthetic runway. */
function limitsAt(ap, regime, pts) {
  const r = ap.runways[0].ends[0];
  const ll = Float64Array.from(pts.flatMap(([s, t]) => offset(r.lat, r.lon, s, t)));
  return B.points64(encodeAirport(ap, regime), ll);
}

describe.skipIf(!haveWasm)('REQ-GAP-73 surfaces: hand-computed heights', () => {
  it('Part 77 precision instrument runway (§77.19(a)–(e))', () => {
    const ap = synthAirport();
    const m = B.surfaces(encodeAirport(ap, 'part77'));
    const kinds = m.surfaces.map((s) => s.kind);
    // The kernel's runway is the chord between the ends: within 1 cm of 3 000 m here.
    const cases = [
      // [s, t, expected height, kind, citation]
      [1500, 30, 605, 'primary', '§77.19(c): elevation of the nearest centreline point'],
      [-(200 + 1000) * FT, 0, 600 + 20 * FT, 'approach', '§77.19(d)(2)(iii): 50:1 for the first 10 000 ft'],
      [-(200 + 20000) * FT, 0, 600 + 450 * FT, 'approach', '§77.19(d)(2)(iii): then 40:1 for 40 000 ft'],
      [1500, (500 + 350) * FT, 605 + 50 * FT, 'transitional', '§77.19(e): 7:1 from the side of the primary surface'],
      [1500, 8000 * FT, 610 + 150 * FT, 'horizontal', '§77.19(a): 150 ft above the airport elevation'],
      [1500, 12000 * FT, 610 + 250 * FT, 'conical', '§77.19(b): 20:1 beyond the 10 000 ft arcs'],
      [-(200 + 30000) * FT, (5000 + 4000) * FT, 600 + (700 + 4000 / 7) * FT, 'transitional', '§77.19(e): 5 000 ft beyond the conical beside a precision approach'],
    ];
    const r = limitsAt(ap, 'part77', cases);
    cases.forEach(([, , z, kind, cite], k) => {
      expect(kinds[r.sid[k]], cite).toBe(kind);
      expect(Math.abs(r.limit[k] - z), cite).toBeLessThan(0.01);
    });
    // Nothing beyond the conical away from the approaches, or beyond 50 000 ft.
    const none = limitsAt(ap, 'part77', [[1500, 14100 * FT], [-(200 + 50100) * FT, 0]]);
    expect([...none.sid]).toEqual([-1, -1]);
  });

  it('Part 77 utility visual runway, unpaved (§77.19(c)(1), (d)(1)(i), (d)(2)(i))', () => {
    const ap = synthAirport({ cats: ['A(V)', 'A(V)'], elev: [300, 300], apElev: 300, paved: false });
    const kinds = B.surfaces(encodeAirport(ap, 'part77')).surfaces.map((s) => s.kind);
    const cases = [
      [1500, 120 * FT, 300, 'primary'],
      [1500, 130 * FT, 300 + (5 / 7) * FT, 'transitional'],
      [-2000 * FT, 320 * FT, 300 + 100 * FT, 'approach'],
      [1500, 4900 * FT, 300 + 150 * FT, 'horizontal'],
      [1500, 5100 * FT, 300 + (150 + 100 / 20) * FT, 'conical'],
    ];
    const r = limitsAt(ap, 'part77', cases);
    cases.forEach(([, , z, kind], k) => {
      expect(kinds[r.sid[k]]).toBe(kind);
      expect(Math.abs(r.limit[k] - z)).toBeLessThan(0.01);
    });
  });

  it('Annex 14 code 4 precision approach runway (Tables 4-1, 4-2; §3.4.3)', () => {
    const ap = synthAirport({ elev: [100, 100], apElev: 100 });
    ap.runways[0].ends[0].takeoff = false;
    const kinds = B.surfaces(encodeAirport(ap, 'icao')).surfaces.map((s) => s.kind);
    const len = 3000;
    const cases = [
      [-1060, 0, 120, 'approach', 'Table 4-1: 60 m before the threshold, 2 % for 3 000 m'],
      [-(60 + 6500), 0, 100 + 60 + 3500 * 0.025, 'approach', 'Table 4-1: then 2.5 % for 3 600 m'],
      [-(60 + 10000), 0, 250, 'approach', 'Table 4-1: horizontal section 150 m above the threshold'],
      [-(60 + 5000), 0, 195, 'conical', 'Table 4-1: conical 5 % beyond the 4 000 m inner horizontal'],
      [1500, 240, 114.3, 'transitional', '§3.4.3 strip 140 m each side; Table 4-1 transitional 14.3 %'],
      [1500, 100, 100, 'strip', 'the strip: the elevation of the nearest centreline point'],
      [1500, 3000, 145, 'innerHorizontal', 'Table 4-1: 45 m above the datum'],
      [len + 60 + 1000, 0, 120, 'approach', 'beyond end 27: the approach to 27 and the take-off climb tie at 2 %'],
    ];
    const r = limitsAt(ap, 'icao', cases);
    cases.forEach(([, , z, kind, cite], k) => {
      expect(kinds[r.sid[k]], cite).toBe(kind);
      expect(Math.abs(r.limit[k] - z), cite).toBeLessThan(0.01);
    });
    // Table 4-2 take-off climb beyond end 27 alone (approach to 27 switched off): 180 m inner edge,
    // 12.5 % divergence to 1 200 m, 2 % to 15 000 m.
    const ap2 = synthAirport({ elev: [100, 100], apElev: 100 });
    ap2.runways[0].ends[1].approach = false;
    const k2 = B.surfaces(encodeAirport(ap2, 'icao')).surfaces.map((s) => s.kind);
    const r2 = limitsAt(ap2, 'icao', [[len + 60 + 1000, 210], [len + 60 + 9000, 595], [len + 60 + 9000, 605], [len + 60 + 14000, 0]]);
    expect(k2[r2.sid[0]]).toBe('takeoff');
    expect(Math.abs(r2.limit[0] - 120)).toBeLessThan(0.01);
    expect(k2[r2.sid[1]]).toBe('takeoff');
    expect(r2.sid[2]).toBe(-1);
    expect(Math.abs(r2.limit[3] - 380)).toBeLessThan(0.01);
  });

  it('refuses malformed definitions by name and keeps working', () => {
    const def = encodeAirport(synthAirport(), 'part77');
    for (const bad of [new Float64Array(0), Float64Array.from([1, 0, 0, 0, 1, 0]), def.slice(0, def.length - 1), Float64Array.from([...def.slice(0, 6), 1, 9, NaN, ...def.slice(9)])]) expect(() => B.surfaces(bad)).toThrow(/obstruction surfaces/);
    const d2 = def.slice();
    d2[9] = 95; // latitude of end A
    expect(() => B.points64(d2, Float64Array.from([36, -115]))).toThrow(/position/);
    expect(B.surfaces(def).surfaces.length).toBe(6);
  });
});

describe('REQ-GAP-73 NASR records', () => {
  it('parses quoted CSV records', () => {
    expect(csvRow('"a","b ""c""",,3,"x,y"')).toEqual(['a', 'b "c"', '', '3', 'x,y']);
    expect(csvRow('1,2,')).toEqual(['1', '2', '']);
  });

  it('reads the fixture airports and matches the FAA published runway lengths and alignments', () => {
    const lens = [];
    for (const id of ['LAS', 'VGT', 'HND', 'CYS', 'BVU', 'SFO', 'OAK', 'CCR', 'HOU', 'KLAS']) {
      const ap = nasrAirport(T, id);
      expect(ap, id).toBeTruthy();
      expect(airportProblems(ap)).toEqual([]);
      for (const r of ap.runways) {
        const [a, b] = r.ends;
        // Geodesic between the NASR end positions (Vincenty-free check: the two-radii formula
        // above, iterated on the mid-latitude; good to 0.1 m over 5 km).
        const lat = (a.lat + b.lat) / 2;
        const p = (lat * Math.PI) / 180;
        const w = Math.sqrt(1 - E2 * Math.sin(p) ** 2);
        const M = (A * (1 - E2)) / w ** 3;
        const N = A / w;
        const dn = ((b.lat - a.lat) * Math.PI * M) / 180;
        const de = ((b.lon - a.lon) * Math.PI * N * Math.cos(p)) / 180;
        const dist = Math.hypot(dn, de);
        const az = ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360;
        lens.push({ id: `${ap.ident} ${r.id}`, published: r.length, computed: dist, alignment: a.trueAlignment, az });
      }
    }
    // FAA RWY_LEN is to the foot; end positions are surveyed. Every runway within 3 m (10 ft) of its
    // published length and within 1° of the published true alignment of its first end.
    for (const l of lens) {
      expect(Math.abs(l.computed - l.published), l.id).toBeLessThan(3.05);
      // NASR leaves TRUE_ALIGNMENT blank for some runways (BVU 15/33).
      if (Number.isFinite(l.alignment)) expect(Math.abs(((l.az - l.alignment + 540) % 360) - 180), l.id).toBeLessThan(1);
    }
    expect(lens.length).toBe(32);
    const las = nasrAirport(T, 'LAS');
    expect(las.name).toBe('HARRY REID INTL');
    expect(las.runways.map((r) => r.id)).toEqual(['01L/19R', '01R/19L', '08L/26R', '08R/26L']);
    expect(las.runways[2].ends.map((e) => e.p77)).toEqual(['B(V)', 'PIR']);
    expect(Math.abs(las.elev - 2183.1 * FT)).toBeLessThan(1e-6);
    expect(Math.abs(las.runways[2].ends[1].disp - 1399 * FT)).toBeLessThan(1e-6);
  });

  it('refuses identifiers by name and says what it leaves out', () => {
    expect(() => nasrAirport(T, 'L A S')).toThrow(/not an airport identifier/);
    expect(nasrAirport(T, 'ZZZ')).toBeNull();
    expect(() => nasrAirport({ base: 'X,Y\n1,2\n', rwy: '', end: '' }, 'LAS')).toThrow(/not a NASR file/);
  });
});

describe.skipIf(!haveWasm || !havePy)('REQ-GAP-73 differential: Rust kernel vs the independent Python reference', () => {
  const cases = [
    ['LAS', 'part77'],
    ['LAS', 'icao'],
    ['VGT', 'part77'],
    ['CYS', 'icao'],
    ['BVU', 'part77'],
    ['SFO', 'part77'],
    ['HOU', 'part77'],
    ['HOU', 'icao'],
    ['SYN-PIR', 'part77'],
    ['SYN-NI1', 'icao'],
  ];
  for (const [id, regime] of cases)
    it(`${id} ${regime}: 20 000 points agree within 1 cm`, () => {
      const ap = id === 'SYN-PIR' ? synthAirport() : id === 'SYN-NI1' ? synthAirport({ cats: ['A(V)', 'A(V)'], icao: [0, 0], code: 1, len: 700, elev: [50, 52], apElev: 52 }) : nasrAirport(T, id);
      const def = encodeAirport(ap, regime);
      const m = B.surfaces(def);
      const [s, w, n, e] = m.bbox;
      const rnd = lcg(id.length * 7919 + (regime === 'icao' ? 1 : 0));
      const ll = [];
      const lat0 = ap.runways[0].ends[0].lat;
      const lon0 = ap.runways[0].ends[0].lon;
      for (let k = 0; k < 20000; k++) {
        if (k % 2) ll.push([s + (n - s) * rnd(), w + (e - w) * rnd()]);
        else ll.push(offset(lat0, lon0, (rnd() - 0.5) * 12000, (rnd() - 0.5) * 12000));
      }
      const r = B.points64(def, Float64Array.from(ll.flat()));
      const dir = mkdtempSync(join(tmpdir(), 'obsref-'));
      const spec = { regime, airport: { elev: ap.elev, runways: ap.runways.map((rw) => ({ paved: rw.paved, code: rw.code, ends: rw.ends.map((en) => ({ lat: en.lat, lon: en.lon, elev: en.elev, p77: en.p77, icao: en.icao, disp: regime === 'icao' ? en.disp : 0, thrElev: en.thrElev, approach: en.approach, takeoff: en.takeoff, clearway: en.clearway })) })) }, points: ll };
      writeFileSync(join(dir, 'in.json'), JSON.stringify(spec));
      execFileSync(PY, ['-I', resolve('tests/tools/obstruction_ref.py'), join(dir, 'in.json'), join(dir, 'out.json')], { timeout: 600000 });
      const ref = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
      let both = 0;
      let maxd = 0;
      const existence = [];
      for (let k = 0; k < ll.length; k++) {
        const a = r.limit[k];
        const b = ref.limit[k];
        if (Number.isFinite(a) && b !== null) {
          both++;
          maxd = Math.max(maxd, Math.abs(a - b));
        } else if (Number.isFinite(a) !== (b !== null)) existence.push(k);
      }
      // A point where only one side finds a surface must lie within 0.5 m of where the kernel's
      // own answer changes (a surface's outer edge).
      for (const k of existence) {
        const [la, lo] = ll[k];
        const nb = [];
        for (let q = 0; q < 8; q++) nb.push(offset(la, lo, 0.5 * Math.cos((q * Math.PI) / 4), 0.5 * Math.sin((q * Math.PI) / 4)));
        const rr = B.points64(def, Float64Array.from(nb.flat()));
        const flips = [...rr.limit].some((v) => Number.isFinite(v) !== Number.isFinite(r.limit[k]));
        expect(flips, `${id} point ${k} (${la}, ${lo}): kernel ${r.limit[k]}, reference ${ref.limit[k]}`).toBe(true);
      }
      expect(both).toBeGreaterThan(5000);
      expect(maxd).toBeLessThan(0.01);
      console.log(`${id} ${regime}: ${both} points on surfaces, max |Δ| ${(maxd * 1000).toFixed(2)} mm, ${existence.length} edge points`);
    }, 120000);
});

describe('REQ-GAP-73 obstacles from penetrating posts and points', () => {
  it('groups 8-connected posts and reports each group at its worst post', () => {
    const w = 60;
    const h = 40;
    const z = new Float32Array(w * h).fill(100);
    const limit = new Float32Array(w * h).fill(110);
    const sid = new Uint8Array(w * h).fill(3);
    // A 3 × 2 block 4 m through, its worst post 9 m through; a diagonal neighbour joins it.
    for (const [i, j] of [[10, 10], [11, 10], [12, 10], [10, 11], [11, 11], [12, 11], [13, 12]]) z[j * w + i] = 114;
    z[11 * w + 11] = 119;
    // A single post 0.4 m through (below a 0.5 m threshold) and another 2 m through.
    z[30 * w + 40] = 110.4;
    z[5 * w + 50] = 112;
    // Voids and posts outside every surface are not counted.
    z[0] = NaN;
    limit[1] = NaN;
    const r = clusterGrid({ w, h, z, limit, sid, minPen: 0.5 });
    expect(r.evaluated).toBe(w * h - 1);
    expect(r.covered).toBe(w * h - 2);
    expect(r.penetrating).toBe(8);
    expect(r.obstacles.length).toBe(2);
    expect(r.obstacles[0]).toMatchObject({ k: 11 * w + 11, posts: 7, sid: 3 });
    expect(r.obstacles[0].pen).toBeCloseTo(9, 5);
    expect(r.obstacles[1]).toMatchObject({ k: 5 * w + 50, posts: 1 });
  });

  it('groups points by neighbouring cells', () => {
    const x = Float64Array.from([0, 1, 2, 3.5, 100, 100.5, 300]);
    const y = Float64Array.from([0, 0.5, 1, 1, 50, 50, 0]);
    const z = Float64Array.from([12, 15, 11, 13, 20, 18, 5]);
    const limit = Float64Array.from([10, 10, 10, 10, 10, 10, 10]);
    const sid = Uint8Array.from([1, 1, 1, 1, 2, 2, 2]);
    const r = clusterPoints({ x, y, z, limit, sid, minPen: 0, cell: 2 });
    expect(r.penetrating).toBe(6);
    expect(r.obstacles.map((o) => [o.k, o.posts])).toEqual([[4, 2], [1, 4]]);
  });

  it('exports CSV and KML', () => {
    const csv = obstaclesCsv([{ id: 'P1', lat: 36.1, lon: -115.1, z: 900, limit: 850.5, pen: 49.5, surface: 'Horizontal', posts: 12 }]);
    expect(csv.split('\n')[1]).toBe('P1,36.1000000,-115.1000000,900.00,850.50,49.50,162.4,Horizontal,12');
    if (!B) return;
    const ap = synthAirport();
    const m = B.surfaces(encodeAirport(ap, 'part77'));
    const kml = surfacesKml(m, m.surfaces.map((s) => s.kind), 'SYN');
    expect(kml).toMatch(/<altitudeMode>absolute<\/altitudeMode>/);
    expect((kml.match(/<Folder>/g) ?? []).length).toBe(m.surfaces.length);
  });
});

describe.skipIf(!haveWasm)('REQ-GAP-73 grid evaluation', () => {
  it('a synthetic DSM with a hand-placed 60 m mast under the approach', () => {
    const ap = synthAirport({ elev: [600, 600], apElev: 600 });
    const def = encodeAirport(ap, 'part77');
    // 1 arc-second posts over 4.5 km × 3 km south of end 36 (the runway runs north), flat at 598 m.
    const e = ap.runways[0].ends[0];
    const [lat0, lon0] = offset(e.lat, e.lon, 500, -1500);
    const dlat = 1 / 3600;
    const dlon = 1 / 3600;
    const g = { w: 120, h: 150 };
    const z = new Float32Array(g.w * g.h).fill(598);
    // The mast: 2 000 m south of end 36 on the extended centreline (1 939.04 m beyond the primary
    // end): approach 50:1 → 38.78 m above 600 m; its top at 658 m pierces it by 19.22 m.
    const [latM, lonM] = offset(e.lat, e.lon, -2000, 0);
    const i = Math.round((lonM - lon0) / dlon);
    const j = Math.round((lat0 - latM) / dlat);
    z[j * g.w + i] = 658;
    const r = B.grid(def, Float64Array.from([g.w, g.h, lat0, lon0, dlat, dlon]), z);
    const c = clusterGrid({ w: g.w, h: g.h, z, limit: r.limit, sid: r.sid, minPen: 0 });
    expect(c.obstacles.length).toBe(1);
    const o = c.obstacles[0];
    expect(o.k).toBe(j * g.w + i);
    const kinds = B.surfaces(def).surfaces.map((s) => s.kind);
    expect(kinds[o.sid]).toBe('approach');
    // The post is within half a post (±15 m along the axis) of the mast: ±0.3 m of height; the
    // grid's limit equals the point evaluation at the post.
    const one = B.points64(def, Float64Array.from([lat0 - j * dlat, lon0 + i * dlon]));
    expect(Math.abs(o.limit - one.limit[0])).toBeLessThan(1e-3);
    expect(Math.abs(o.pen - 19.22)).toBeLessThan(0.6);
  });
});
