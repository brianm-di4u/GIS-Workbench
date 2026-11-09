// Airfield obstruction analysis (REQ-GAP-73), DOM-free: FAA NASR airport and runway records,
// the definition list of the `aviation` WASM bundle (crates/gw-aviation model.rs), grouping of
// penetrating posts and points into obstacles, and the KML / GeoJSON / CSV exports.
//
// NASR is the FAA's 28-day National Airspace System Resources subscription (public domain): the
// APT_BASE, APT_RWY and APT_RWY_END CSV files. Elevations there are feet (NAVD 88 in the
// conterminous US), positions NAD 83 decimal degrees; both are kept as metres and taken as WGS 84
// (NAD 83 and WGS 84 differ by about 1–2 m horizontally in CONUS).

import { N_ } from '../i18n/index.js';

export const FT = 0.3048;
/** Part 77 categories as NASR FAR_PART_77_CODE writes them, in definition-list order. */
export const P77_CODES = ['A(V)', 'A(NP)', 'B(V)', 'C', 'D', 'PIR'];
/** Annex 14 approach runway types, in definition-list order. */
export const ICAO_TYPES = ['NI', 'NPA', 'PA-I', 'PA-II/III'];
/**
 * What each regime's surfaces follow, by regime ('part77' has none). In the dialog, the results and
 * the exports, so that a label can only say what the kernel does: it changes with the tables, never
 * apart. English in files; the app translates its own copies.
 */
export const EDITIONS = {
  icao: 'ICAO Annex 14 Volume I as amended by Amendment 18, Chapter 4 as applicable until 20 November 2030',
  'icao-a18': 'ICAO Annex 14 Volume I as amended by Amendment 18, Chapter 4 as applicable from 21 November 2030: obstacle free surfaces and obstacle evaluation surfaces',
};
export const editionOf = (regime) => EDITIONS[regime] ?? null;
/** Regimes in definition-list order. */
export const REGIMES = ['part77', 'icao', 'icao-a18'];
/** Amendment 18's Chapter 4 applies from this date (SL 2025/23; PDF pp.24-25). */
export const A18_FROM = '2030-11-21';
/** The Annex 14 edition that applies on a date (YYYY-MM-DD, or a Date): the regime key. */
export function editionForDate(date) {
  const d = date instanceof Date ? date.toISOString().slice(0, 10) : String(date ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= A18_FROM ? 'icao-a18' : 'icao';
}
/** Aeroplane design groups (Table 1-2), in definition-list order from 1. */
export const ADGS = ['I', 'IIA', 'IIB', 'IIC', 'III', 'IV', 'V'];
/** Surfaces reported apart as the zone: the current edition's obstacle-free zone (crates/gw-aviation). */
export const ZONE_KINDS = ['innerApproach', 'innerTransitional', 'balkedLanding', 'ofzStrip'];
/** Amendment 18's obstacle free surfaces (§4.2), its zone; every other surface of it is an OES. */
export const OFS_KINDS = ['approach', 'transitional', 'innerApproach', 'innerTransitional', 'balkedLanding', 'ofzStrip'];
/** A regime whose model always reports a zone limit. */
export const hasOfs = (regime) => regime === 'icao-a18';

/**
 * Table 1-2 (Amendment 18, PDF pp.29-30): the ADG (1 I … 7 V) of an aeroplane from its indicated
 * airspeed at threshold (km/h) and wingspan (m), or null beyond the table's 80 m. The table covers
 * speeds below 307 km/h only; at 307 km/h and above §1.8.2's "highest values" rule is applied: the
 * speed then counts as IIC's band, the highest, and the group is the higher of that and the wingspan's
 * (`assumed` says so).
 */
export function adgOf(vatKmh, spanM) {
  if (!(Number.isFinite(vatKmh) && vatKmh > 0 && Number.isFinite(spanM) && spanM > 0) || spanM >= 80) return null;
  const bySpan = spanM < 24 ? 1 : spanM < 36 ? 2 : spanM < 52 ? 5 : spanM < 65 ? 6 : 7;
  const bySpeed = vatKmh < 169 ? 1 : vatKmh < 224 ? 3 : 4;
  return { adg: Math.max(bySpan, bySpeed), assumed: vatKmh >= 307 };
}

/** A runway's ADG as a number 1-7 (from r.adg, a label or number, else r.vat and r.span), or 0. */
export function adgNumber(r) {
  if (Number.isInteger(r?.adg) && r.adg >= 1 && r.adg <= 7) return r.adg;
  const i = ADGS.indexOf(String(r?.adg ?? ''));
  if (i >= 0) return i + 1;
  return adgOf(r?.vat, r?.span)?.adg ?? 0;
}

/**
 * The readings the Amendment 18 kernel takes where the document is silent or ambiguous
 * (crates/gw-aviation/src/a18.rs A_*), by bit; the last is this module's (adgOf). A run's result lists
 * those its model made.
 */
export const A18_ASSUMPTIONS = [
  [1 << 0, N_('The transitional surfaces start at the strip edge, its half-width from Chapter 3 as in the current edition (§4.2.2.2 gives no distance); the strip itself is limited at the elevation of the nearest centre line point and is not an OFS.')],
  [1 << 1, N_('The inner transitional surfaces start at half the inner approach width, along its sides carried on (§4.2.4.2 and §4.2.4.3 give no distance).')],
  [1 << 2, N_('Non-instrument and non-precision runways: the inner transitional runs along the whole inner approach (§4.2.4.2 gives no height for its start), its vertical section measured from its lower edge.')],
  [1 << 3, N_('The transitional slope is the 20 % upper limit of §4.2.2.5.')],
  [1 << 4, N_('The OES follow the runways, not the operations (§4.5.2.1): a horizontal surface for every runway, except a runway whose best approach is non-precision, which has the straight-in surface instead; the precision approach surface at precision approach ends; an instrument departure surface beyond every take-off end of a runway with an instrument approach; a take-off climb surface beyond every take-off end.')],
  [1 << 5, N_('Table 4-11: the shorter side is 7 410 m in all (3 705 m each side of the centre line) and the longer sides reach 5 350 m before and after the thresholds; the upper section is 60 m high.')],
  [1 << 6, N_('One aeroplane design group per runway, its critical aeroplane: the lower horizontal surfaces of smaller groups that also use it (Table 4-10 note) are not added.')],
  [1 << 7, N_('Exactly 5 700 kg takes Table 4-14, as §4.3.6.6 reads, although the table’s note a says "up to but not including 5 700 kg".')],
  [1 << 8, N_('5 700 kg or less on an ADG IIC to V runway: Table 4-14 has no values for these groups, so Table 4-15 is used.')],
  [1 << 9, N_('Table 4-15 take-off climb surfaces start at the end of the take-off distance available (its distance row is "-").')],
  [1 << 10, N_('Take-off climb surfaces start at the elevation of the runway end, and departure surfaces 5 m above it: §4.3.6.4 takes the highest point on the extended centre line, which this tool does not know.')],
  [1 << 11, N_('Table 4-13 prints one 2.5 % slope, taken for both sections of the departure surface.')],
  [1 << 12, N_('A runway width is not known: the inner edges of Tables 4-1 and 4-2 are as printed, without the runway width notes.')],
  [1 << 13, N_('The code letter F notes of Tables 4-3 to 4-5 and 4-9 are applied to ADG V.')],
  [1 << 14, N_('Slopes and lengths as printed: not reduced for approach angles under 3°, visual approach slope indicators or an OCH above 150 m (§4.2.1.8 to §4.2.1.11, §4.2.3.7), nor the take-off climb for critical operating conditions (§4.3.6.9).')],
  [1 << 15, N_('An aeroplane at 307 km/h or more matches no row of Table 1-2: by the "highest values" rule of §1.8.2 its speed counts in the IIC band, and the group is the higher of that and its wingspan’s.')],
];
/** The JS-side assumption bit: an ADG found from a speed of 307 km/h or more. */
export const A18_ADG_SPEED = 1 << 15;
/** The English texts of the assumptions in `bits`. */
export const assumptionsOf = (bits) => A18_ASSUMPTIONS.filter(([b]) => bits & b).map(([, s]) => s);

/** One CSV record (RFC 4180 quoting) → fields. */
export function csvRow(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i <= n) {
    if (line[i] === '"') {
      let s = '';
      i++;
      for (;;) {
        const q = line.indexOf('"', i);
        if (q < 0) {
          s += line.slice(i);
          i = n + 1;
          break;
        }
        s += line.slice(i, q);
        if (line[q + 1] === '"') {
          s += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      out.push(s);
      if (line[i] === ',') i++;
      else if (i >= n) break;
    } else {
      const c = line.indexOf(',', i);
      if (c < 0) {
        out.push(line.slice(i).replace(/\r$/, ''));
        break;
      }
      out.push(line.slice(i, c));
      i = c + 1;
      if (i === n) {
        out.push('');
        break;
      }
    }
  }
  return out;
}

/** A CSV line without a byte-order mark or a trailing carriage return. */
const trimLine = (s) => s.replace(/^\uFEFF/, '').replace(/\r$/, '');

/** Rows of a NASR CSV whose `col` equals one of `values` (a quick text scan, then a full parse). */
function rowsWhere(text, col, values) {
  const nl = text.indexOf('\n');
  const head = csvRow(trimLine(text.slice(0, nl < 0 ? text.length : nl)));
  const ix = head.indexOf(col);
  if (ix < 0) throw Object.assign(new Error(`not a NASR file: no ${col} column`), { code: 'E_NASR_COLUMNS' });
  const out = [];
  for (const v of values) {
    const needle = `"${v}"`;
    let p = text.indexOf(needle, nl);
    while (p >= 0) {
      const a = text.lastIndexOf('\n', p) + 1;
      let b = text.indexOf('\n', p);
      if (b < 0) b = text.length;
      const f = csvRow(trimLine(text.slice(a, b)));
      if (f[ix] === v) out.push(Object.fromEntries(head.map((h, k) => [h, f[k] ?? ''])));
      p = text.indexOf(needle, b);
    }
  }
  return out;
}

const numOr = (v, d = NaN) => {
  const x = Number(String(v ?? '').trim());
  return String(v ?? '').trim() === '' || !Number.isFinite(x) ? d : x;
};

/** Annex 14 aerodrome reference code number from the runway length (an approximation of the aeroplane reference field length, Table 1-1). */
export function icaoCodeNumber(lengthM) {
  return lengthM >= 1800 ? 4 : lengthM >= 1200 ? 3 : lengthM >= 800 ? 2 : 1;
}

/** Annex 14 approach type for a NASR runway end: PIR → precision category I, non-precision codes → NPA, visual → non-instrument. */
export function icaoTypeOf(p77) {
  return p77 === 'PIR' ? 2 : p77 === 'C' || p77 === 'D' || p77 === 'A(NP)' ? 1 : 0;
}

const PAVED = /^(CONC|ASPH|PEM|BIT|ASPH-CONC)/i;

/**
 * The airport whose FAA location identifier or ICAO code is `ident`, from the NASR CSV texts
 * {base, rwy, end}; null when no row matches. Helipads (H…) and water lanes are left out, with a
 * note. Throws by name when a runway end has no position or elevation.
 */
export function nasrAirport({ base, rwy, end }, ident) {
  const id = String(ident).trim().toUpperCase();
  if (!/^[A-Z0-9]{2,4}$/.test(id)) throw Object.assign(new Error(`"${ident}" is not an airport identifier`), { code: 'E_NASR_IDENT' });
  let b = rowsWhere(base, 'ARPT_ID', [id]);
  if (!b.length) b = rowsWhere(base, 'ICAO_ID', [id]);
  if (!b.length) return null;
  const B = b[0];
  const site = B.SITE_NO;
  const rws = rowsWhere(rwy, 'SITE_NO', [site]);
  const ends = rowsWhere(end, 'SITE_NO', [site]);
  const notes = [];
  const runways = [];
  for (const r of rws) {
    if (/^H/i.test(r.RWY_ID) || /WATER/i.test(r.SURFACE_TYPE_CODE)) {
      notes.push({ src: N_('Runway {rwy} left out: helipads and water lanes have no Part 77 runway surfaces here'), params: { rwy: r.RWY_ID } });
      continue;
    }
    const es = ends.filter((e) => e.RWY_ID === r.RWY_ID);
    const ids = r.RWY_ID.split('/');
    const pair = ids.map((x) => es.find((e) => e.RWY_END_ID === x));
    if (pair.length !== 2 || pair.some((e) => !e)) {
      notes.push({ src: N_('Runway {rwy} left out: NASR has no record for both of its ends'), params: { rwy: r.RWY_ID } });
      continue;
    }
    const bad = pair.find((e) => !Number.isFinite(numOr(e.LAT_DECIMAL)) || !Number.isFinite(numOr(e.LONG_DECIMAL)) || !Number.isFinite(numOr(e.RWY_END_ELEV)));
    if (bad) {
      notes.push({ src: N_('Runway {rwy} left out: end {end} has no surveyed position or elevation in NASR'), params: { rwy: r.RWY_ID, end: bad.RWY_END_ID } });
      continue;
    }
    const lengthM = numOr(r.RWY_LEN) * FT;
    const code = icaoCodeNumber(lengthM);
    runways.push({
      id: r.RWY_ID,
      length: lengthM,
      width: numOr(r.RWY_WIDTH) * FT,
      surface: r.SURFACE_TYPE_CODE,
      paved: PAVED.test(r.SURFACE_TYPE_CODE),
      code,
      ends: pair.map((e) => {
        const p77 = P77_CODES.includes(e.FAR_PART_77_CODE) ? e.FAR_PART_77_CODE : 'B(V)';
        if (!P77_CODES.includes(e.FAR_PART_77_CODE)) notes.push({ src: N_('Runway end {end}: no Part 77 category in NASR; taken as B(V) (visual)'), params: { end: e.RWY_END_ID } });
        const de = numOr(e.DISPLACED_THR_ELEV);
        return {
          id: e.RWY_END_ID,
          lat: numOr(e.LAT_DECIMAL),
          lon: numOr(e.LONG_DECIMAL),
          elev: numOr(e.RWY_END_ELEV) * FT,
          p77,
          icao: icaoTypeOf(p77),
          ils: e.ILS_TYPE || '',
          disp: numOr(e.DISPLACED_THR_LEN, 0) * FT,
          thrElev: Number.isFinite(de) ? de * FT : null,
          tdzElev: Number.isFinite(numOr(e.TDZ_ELEV)) ? numOr(e.TDZ_ELEV) * FT : null,
          trueAlignment: numOr(e.TRUE_ALIGNMENT),
          clearway: 0,
          approach: true,
          takeoff: true,
          // NASR's controlling obstacle for the end (FAA 5010 item 23–28), kept for comparison.
          nasrObstacle: e.OBSTN_TYPE ? { type: e.OBSTN_TYPE, heightFt: numOr(e.OBSTN_HGT), distFt: numOr(e.DIST_FROM_THR), offsetFt: numOr(e.CNTRLN_OFFSET), side: e.CNTRLN_DIR_CODE, slope: numOr(e.OBSTN_CLNC_SLOPE) } : null,
        };
      }),
    });
  }
  return {
    ident: B.ARPT_ID,
    icao: B.ICAO_ID || '',
    name: B.ARPT_NAME,
    city: B.CITY,
    state: B.STATE_CODE,
    elev: numOr(B.ELEV) * FT,
    arp: { lat: numOr(B.LAT_DECIMAL), lon: numOr(B.LONG_DECIMAL) },
    source: 'FAA NASR',
    eff: B.EFF_DATE,
    runways,
    notes,
  };
}

/** Problems that stop an airport from being evaluated under `regime` (English templates with params). */
export function airportProblems(ap, regime = null) {
  const p = [];
  if (!ap || !Number.isFinite(ap.elev)) p.push({ src: N_('The airport has no elevation'), params: null });
  if (!ap?.runways?.length) p.push({ src: N_('The airport has no runways'), params: null });
  if ((ap?.runways?.length ?? 0) > 32) p.push({ src: N_('At most 32 runways can be evaluated together'), params: null });
  for (const r of ap?.runways ?? []) {
    if (r.ends?.length !== 2) {
      p.push({ src: N_('Runway {rwy} needs two ends'), params: { rwy: r.id } });
      continue;
    }
    for (const e of r.ends)
      if (!Number.isFinite(e.lat) || !Number.isFinite(e.lon) || Math.abs(e.lat) > 85 || Math.abs(e.lon) > 180 || !Number.isFinite(e.elev))
        p.push({ src: N_('Runway end {end} needs a position and an elevation'), params: { end: e.id } });
    if (![1, 2, 3, 4].includes(r.code)) p.push({ src: N_('Runway {rwy}: the code number must be 1 to 4'), params: { rwy: r.id } });
    else if (regime === 'icao' && r.code < 3 && r.ends.some((e) => e.icao === 3)) p.push({ src: N_('Runway {rwy}: Annex 14 Table 4-1 has no precision category II or III column for code number {code}'), params: { rwy: r.id, code: r.code } });
    if (regime === 'icao' || regime === 'icao-a18') for (const e of r.ends) if ((e.icao >= 2 || (regime === 'icao-a18' && e.approach !== false)) && Number.isFinite(r.length) && (e.disp ?? 0) >= r.length) p.push({ src: N_('Runway end {end}: the displaced threshold lies beyond the far end of the runway'), params: { end: e.id } });
    if (regime === 'icao-a18') {
      if (!adgNumber(r)) p.push({ src: N_('Runway {rwy}: Amendment 18 needs the aeroplane design group of its critical aeroplane (§1.8.1)'), params: { rwy: r.id } });
      if (r.ends.some((e) => e.takeoff !== false) && !massOf(r)) p.push({ src: N_('Runway {rwy}: Amendment 18 needs the maximum take-off mass of its aeroplanes for the take-off climb surface (§4.3.6.6)'), params: { rwy: r.id } });
    }
  }
  return p;
}

/** A runway's maximum take-off mass (kg) as the kernel takes it, or NaN. */
const massOf = (r) => (Number.isFinite(r?.mtom) && r.mtom >= 1 && r.mtom <= 1e6 ? r.mtom : NaN);
/** A runway's width (m) as the kernel takes it, or NaN (unknown). */
// Draw Runway stored 45 m as a placeholder width (with no surface) until 2.7.0, and saved projects
// keep it; that is not a measured width. A NASR width is whole feet, so never exactly 45 m.
const widthOf = (r) => (r?.surface === '' && r.width === 45 ? NaN : Number.isFinite(r?.width) && r.width >= 3 && r.width <= 150 ? r.width : NaN);

/**
 * The definition list (version 3) for the `aviation` bundle. regime 'part77', 'icao' (the current
 * Annex 14 Chapter 4) or 'icao-a18' (Amendment 18's from 21 November 2030, which needs each runway's
 * aeroplane design group, `adg`, and for take-off climb surfaces its maximum take-off mass, `mtom` kg;
 * its width, `width` m, chooses the approach inner edge); opts.ihsDatum (m) for the current Annex 14
 * inner horizontal surface (default: the aerodrome elevation); opts.codeF when the aerodrome takes code
 * letter F aeroplanes without go-around steering avionics (the inner edges of the obstacle-free zone
 * are then 140 m on code 3 and 4 precision runways, and on ADG V runways under Amendment 18).
 */
export function encodeAirport(ap, regime, { ihsDatum = NaN, codeF = false } = {}) {
  const v = [3, Math.max(0, REGIMES.indexOf(regime)), ap.elev, Number.isFinite(ihsDatum) ? ihsDatum : NaN, ap.runways.length, codeF ? 1 : 0];
  const annex = regime === 'icao' || regime === 'icao-a18';
  for (const r of ap.runways) {
    v.push(r.paved ? 1 : 0, r.code ?? icaoCodeNumber(r.length ?? 0), Number.isFinite(r.tocsWidth) ? r.tocsWidth : NaN, adgNumber(r), widthOf(r), massOf(r));
    for (const e of r.ends) {
      const p77 = Math.max(0, P77_CODES.indexOf(e.p77));
      const flags = (e.approach !== false ? 1 : 0) + (e.takeoff !== false ? 2 : 0);
      v.push(e.lat, e.lon, e.elev, p77, e.icao ?? icaoTypeOf(e.p77), annex ? e.disp ?? 0 : 0, Number.isFinite(e.thrElev) ? e.thrElev : NaN, flags, e.clearway ?? 0);
    }
  }
  return Float64Array.from(v);
}

/**
 * Obstacles from a grid evaluation: 8-connected groups of posts whose height is more than
 * `minPen` above the limiting surface. Each obstacle is reported at its most penetrating post.
 * Returns {obstacles: [{k, pen, z, limit, sid, posts}], evaluated, covered, penetrating}.
 */
export function clusterGrid({ w, h, z, limit, sid, minPen = 0 }) {
  const n = w * h;
  const pen = new Uint8Array(n);
  let covered = 0;
  let evaluated = 0;
  let penetrating = 0;
  let minClearance = Infinity;
  let minAt = -1;
  for (let k = 0; k < n; k++) {
    if (!Number.isFinite(z[k])) continue;
    evaluated++;
    if (!Number.isFinite(limit[k])) continue;
    covered++;
    if (limit[k] - z[k] < minClearance) {
      minClearance = limit[k] - z[k];
      minAt = k;
    }
    if (z[k] - limit[k] > minPen) {
      pen[k] = 1;
      penetrating++;
    }
  }
  const obstacles = [];
  const stack = new Int32Array(Math.max(1, penetrating));
  for (let k0 = 0; k0 < n; k0++) {
    if (pen[k0] !== 1) continue;
    pen[k0] = 2;
    let top = 0;
    stack[top++] = k0;
    let best = k0;
    let bestPen = z[k0] - limit[k0];
    let count = 0;
    while (top) {
      const k = stack[--top];
      count++;
      const p = z[k] - limit[k];
      if (p > bestPen) {
        bestPen = p;
        best = k;
      }
      const i = k % w;
      const j = (k - i) / w;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if ((di || dj) && ii >= 0 && jj >= 0 && ii < w && jj < h) {
            const q = jj * w + ii;
            if (pen[q] === 1) {
              pen[q] = 2;
              stack[top++] = q;
            }
          }
        }
    }
    obstacles.push({ k: best, pen: bestPen, z: z[best], limit: limit[best], sid: sid[best], posts: count });
  }
  obstacles.sort((a, b) => b.pen - a.pen);
  return { obstacles, evaluated, covered, penetrating, minClearance: minAt >= 0 ? minClearance : NaN, minAt };
}

/**
 * Obstacles from a point evaluation: points more than `minPen` above the surface, grouped where
 * they fall in the same or neighbouring `cell` m cells. x, y are metres in any local frame.
 */
export function clusterPoints({ x, y, z, limit, sid, minPen = 0, cell = 5 }) {
  const n = z.length;
  const idx = [];
  let covered = 0;
  let minClearance = Infinity;
  let minAt = -1;
  for (let k = 0; k < n; k++) {
    if (!Number.isFinite(limit[k]) || !Number.isFinite(z[k])) continue;
    covered++;
    if (limit[k] - z[k] < minClearance) {
      minClearance = limit[k] - z[k];
      minAt = k;
    }
    if (z[k] - limit[k] > minPen) idx.push(k);
  }
  const key = (a, b) => `${a},${b}`;
  const cells = new Map();
  for (const k of idx) {
    const c = key(Math.floor(x[k] / cell), Math.floor(y[k] / cell));
    if (!cells.has(c)) cells.set(c, []);
    cells.get(c).push(k);
  }
  const seen = new Set();
  const obstacles = [];
  for (const c0 of cells.keys()) {
    if (seen.has(c0)) continue;
    seen.add(c0);
    const queue = [c0];
    let best = -1;
    let bestPen = -Infinity;
    let count = 0;
    while (queue.length) {
      const c = queue.pop();
      for (const k of cells.get(c)) {
        count++;
        const p = z[k] - limit[k];
        if (p > bestPen) {
          bestPen = p;
          best = k;
        }
      }
      const [a, b] = c.split(',').map(Number);
      for (let da = -1; da <= 1; da++)
        for (let db = -1; db <= 1; db++) {
          const q = key(a + da, b + db);
          if (cells.has(q) && !seen.has(q)) {
            seen.add(q);
            queue.push(q);
          }
        }
    }
    obstacles.push({ k: best, pen: bestPen, z: z[best], limit: limit[best], sid: sid[best], posts: count });
  }
  obstacles.sort((a, b) => b.pen - a.pen);
  return { obstacles, evaluated: n, covered, penetrating: idx.length, minClearance: minAt >= 0 ? minClearance : NaN, minAt };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/**
 * Obstacle rows: {id, lat, lon, z, limit, pen, surface, posts, zone}. Heights orthometric metres. An
 * edition adds the columns obstacle_free_zone and edition: a CSV row has nowhere else to carry them.
 */
export function obstaclesCsv(rows, { vertical = 'orthometric', edition = null } = {}) {
  const head = ['id', 'lat', 'lon', `top_m_${vertical}`, 'surface_m', 'penetration_m', 'penetration_ft', 'surface', 'posts_or_points', ...(edition ? ['obstacle_free_zone', 'edition'] : [])];
  const lines = rows.map((r) => [r.id, r.lat.toFixed(7), r.lon.toFixed(7), r.z.toFixed(2), r.limit.toFixed(2), r.pen.toFixed(2), (r.pen / FT).toFixed(1), r.surface, r.posts, ...(edition ? [r.zone ? 'yes' : 'no', edition] : [])].map(csvCell).join(','));
  return `${head.join(',')}\n${lines.join('\n')}\n`;
}

export function obstaclesGeoJson(rows, meta = {}) {
  return JSON.stringify({
    type: 'FeatureCollection',
    gisWorkbench: { kind: 'obstruction-penetrations', vertical: 'orthometric (m)', ...meta },
    features: rows.map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [+r.lon.toFixed(8), +r.lat.toFixed(8), +r.z.toFixed(3)] }, properties: { id: r.id, top_m: +r.z.toFixed(3), surface_m: +r.limit.toFixed(3), penetration_m: +r.pen.toFixed(3), surface: r.surface, posts: r.posts, ...(r.zone ? { obstacleFreeZone: true } : {}) } })),
  });
}

const kmlNote = (edition) => (edition ? `<description>${esc(edition)}</description>` : '');

/** KML of obstacles (absolute altitudes: orthometric, as KML's sea-level heights). */
export function obstaclesKml(rows, name, { edition = null } = {}) {
  const pm = rows.map((r) => `<Placemark><name>${esc(r.id)}</name><description>${esc(`${r.surface}: +${r.pen.toFixed(2)} m (top ${r.z.toFixed(2)} m, surface ${r.limit.toFixed(2)} m)`)}</description><styleUrl>#pen</styleUrl><Point><altitudeMode>absolute</altitudeMode><coordinates>${r.lon.toFixed(8)},${r.lat.toFixed(8)},${r.z.toFixed(2)}</coordinates></Point></Placemark>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>${kmlNote(edition)}<Style id="pen"><IconStyle><color>ff0000ff</color></IconStyle></Style>${pm.join('')}</Document></kml>\n`;
}

const SURF_COLOUR = { primary: '#ffffff', strip: '#ffffff', approach: '#00c853', transitional: '#ffab00', horizontal: '#2979ff', innerHorizontal: '#2979ff', conical: '#d500f9', takeoff: '#00e5ff', innerApproach: '#76ff03', innerTransitional: '#ff6d00', balkedLanding: '#ffea00', ofzStrip: '#ffffff', straightIn: '#2979ff', precisionApproach: '#1de9b6', precisionMissedApproach: '#c6ff00', precisionTransitional: '#ffd180', precisionLower: '#b2dfdb', departure: '#18ffff' };
export const surfaceColour = (kind) => SURF_COLOUR[kind] ?? '#888888';
const kmlColour = (hex, a = 'ff') => `${a}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`;

/** KML of the 3D surfaces: one polygon per facet, absolute (orthometric) altitudes. `names[i]` names surface i. */
export function surfacesKml(model, names, name, { edition = null } = {}) {
  const kinds = [...new Set(model.surfaces.map((s) => s.kind))];
  const styles = kinds.map((k) => `<Style id="${k}"><LineStyle><color>${kmlColour(surfaceColour(k))}</color><width>1</width></LineStyle><PolyStyle><color>${kmlColour(surfaceColour(k), '55')}</color></PolyStyle></Style>`);
  const folders = model.surfaces.map((s, i) => {
    const pm = model.facets
      .filter((f) => f.s === i)
      .map((f) => {
        const ring = [...f.ring, f.ring[0]].map(([la, lo, z]) => `${lo.toFixed(8)},${la.toFixed(8)},${z.toFixed(2)}`).join(' ');
        return `<Placemark><styleUrl>#${s.kind}</styleUrl><Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
      });
    return `<Folder><name>${esc(names[i])}</name>${pm.join('')}</Folder>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>${kmlNote(edition)}${styles.join('')}${folders.join('')}</Document></kml>\n`;
}

export function surfacesGeoJson(model, names, meta = {}) {
  return JSON.stringify({
    type: 'FeatureCollection',
    gisWorkbench: { kind: 'obstruction-surfaces', vertical: 'orthometric (m)', ...meta },
    features: model.facets.map((f) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...f.ring, f.ring[0]].map(([la, lo, z]) => [lo, la, z])] }, properties: { surface: names[f.s], kind: model.surfaces[f.s].kind } })),
  });
}

/** Runway designator pair for a bearing (°T): 093° → "09/27". */
export function designator(bearing) {
  const a = Math.round((((bearing % 360) + 360) % 360) / 10) % 36 || 36;
  const b = ((a + 17) % 36) + 1;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(a)}/${p(b)}`;
}
