// Address geocoding on the user's own data (REQ-GAP-85): the pure parts. An index of address
// points (a number on a street) and street ranges (a line with the first and last numbers on each
// side), forward search — exact, fuzzy by street-name trigrams, and interpolated along a range —
// and reverse search. No network service, no DOM. Coordinates are lon/lat (WGS 84).

// Street-type and direction words, written short so "Main Street" and "main st" are one street.
const SHORT = {
  street: 'st', avenue: 'ave', av: 'ave', road: 'rd', boulevard: 'blvd', drive: 'dr', lane: 'ln', court: 'ct', place: 'pl', terrace: 'ter', highway: 'hwy', parkway: 'pkwy', square: 'sq', crescent: 'cres', circle: 'cir', trail: 'trl', alley: 'aly', expressway: 'expy', freeway: 'fwy',
  north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th', eleventh: '11th', twelfth: '12th',
};

/** Lower case, no accents or punctuation, street types and directions short: "Rue de l'Église" → "rue de l eglise". */
export function normalise(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => SHORT[w] ?? w)
    .join(' ');
}

/** The house number of an address ("12", "12A", "12-14" → 12), or NaN. */
export const houseNumber = (s) => {
  const m = /^\s*(\d+)/.exec(String(s ?? ''));
  return m ? Number(m[1]) : NaN;
};
/** A house number's letter ("12A", "12 b" → "a", "b"), or ''. */
const suffixOf = (s) => /^\s*\d+\s?([a-z])(?![a-z])/i.exec(String(s ?? ''))?.[1].toLowerCase() ?? '';

/**
 * A free-text query → {number, suffix, street, rest, last, whole}: "221B Baker Street, London" →
 * 221, "b", "baker st", "london"; "Baker Street 221" (number last, as in much of Europe) → the
 * same with `last` set, since a number last may instead be part of the street ("Route 66"):
 * `whole` keeps it. Text after the first comma is the place.
 */
export function parseQuery(q) {
  const [head, ...tail] = String(q ?? '').split(',');
  const raw = head.trim();
  const out = { number: NaN, suffix: '', street: normalise(raw), rest: normalise(tail.join(' ')), last: false, whole: normalise(raw) };
  // The number is read from the text as typed, before normalising turns "12-14" into two words:
  // "12", "12A" or "12-14" first. A lone letter after the number is the street's ("502 C Avenue",
  // "12 N Main St"), with the number's letter ("12 B Main St") as the other reading, in `alt`.
  let m = /^(\d+)(?:\s*[-–/]\s*\d+)?([a-z])?\s+(.+)$/i.exec(raw);
  if (m) {
    const street = normalise(m[3]);
    const lone = /^([a-z])\s+(.+)$/i.exec(m[3]);
    const alt = !m[2] && lone && !/^[nsew]$/i.test(lone[1]) ? { suffix: lone[1].toLowerCase(), street: normalise(lone[2]) } : null;
    if (street) return { ...out, number: +m[1], suffix: (m[2] || '').toLowerCase(), street, ...(alt ? { alt } : {}) };
  }
  // … or last, as in much of Europe ("Baker Street 221", "Hauptstraße 12-14").
  m = /^(.+?)\s+(\d+)(?:\s*[-–/]\s*\d+)?([a-z])?$/i.exec(raw);
  if (m) {
    const street = normalise(m[1]);
    if (street) return { ...out, number: +m[2], suffix: (m[3] || '').toLowerCase(), street, last: true };
  }
  return out;
}

const trigrams = (s) => {
  const p = `  ${s} `;
  const out = new Set();
  for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  return out;
};
/** Edit distance with adjacent transpositions (optimal string alignment). */
function osa(a, b) {
  const m = a.length;
  const n = b.length;
  let d2 = null;
  let d1 = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const d = [i];
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[j] = Math.min(d1[j] + 1, d[j - 1] + 1, d1[j - 1] + c);
      if (d2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[j] = Math.min(d[j], d2[j - 2] + 1);
    }
    d2 = d1;
    d1 = d;
  }
  return d1[n];
}
const close = (a, b) => {
  const A = trigrams(a);
  const B = trigrams(b);
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return Math.max((2 * n) / (A.size + B.size), 1 - osa(a, b) / Math.max(a.length, b.length, 1));
};
const sorted = (s) => s.split(' ').sort().join(' ');
/**
 * Similarity of two street names, 0..1 (0 when their numbered words differ): the better of their trigram Dice coefficient (a word
 * missing or added) and one minus their edit distance over the longer length (typing slips and
 * swapped letters, which trigrams punish), and the same on the words in sorted order, a little
 * lower, so "Avenue G" finds "G Avenue".
 */
export function similarity(a, b) {
  if (a === b) return 1;
  // Numbered streets are different streets: "4th St" is never a slip for "5th St", nor "5th Ave" for "H Ave".
  const nums = (x) => x.split(' ').filter((w) => /\d/.test(w)).sort().join(' ');
  if (nums(a) !== nums(b)) return 0;
  return Math.max(close(a, b), 0.95 * close(sorted(a), sorted(b)));
}

const M_PER_DEG = 111320;
/** Metres between two lon/lat points, near enough for ranking within a city (equirectangular). */
export function metres(a, b) {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * M_PER_DEG;
}

function lineLength(c) {
  let L = 0;
  for (let i = 1; i < c.length; i++) L += metres(c[i - 1], c[i]);
  return L;
}
/** The point a fraction f of the way along a line (by length). */
export function along(c, f) {
  const L = lineLength(c);
  let d = Math.max(0, Math.min(1, f)) * L;
  for (let i = 1; i < c.length; i++) {
    const s = metres(c[i - 1], c[i]);
    if (d <= s || i === c.length - 1) {
      const u = s > 0 ? Math.min(1, d / s) : 0;
      return [c[i - 1][0] + u * (c[i][0] - c[i - 1][0]), c[i - 1][1] + u * (c[i][1] - c[i - 1][1])];
    }
    d -= s;
  }
  return c[0];
}

/**
 * An index of `points` ({id, number, street, place, at: [lon, lat]}) and `ranges` ({id, street,
 * place, line: [[lon, lat]…], left: [first, last], right: [first, last]}; a side with no numbers
 * is null). Streets are keyed by their normalised name; their trigrams find near misses.
 */
export function buildIndex({ points = [], ranges = [] }) {
  const streets = new Map();
  const street = (name) => {
    const key = normalise(name);
    if (!key) return null;
    let s = streets.get(key);
    if (!s) streets.set(key, (s = { key, name: String(name).trim(), points: [], ranges: [], tri: trigrams(key) }));
    return s;
  };
  for (const p of points) {
    if (!Array.isArray(p.at) || !p.at.every(Number.isFinite)) continue;
    street(p.street)?.points.push({ ...p, n: houseNumber(p.number), sfx: suffixOf(p.number), place: normalise(p.place) });
  }
  // A side with no numbers: missing, not numbers, or 0 to 0.
  const side = (x) => (Array.isArray(x) && x.length === 2 && x.every(Number.isFinite) && (x[0] || x[1]) ? x : null);
  for (const r of ranges) {
    if (!Array.isArray(r.line) || r.line.length < 2) continue;
    street(r.street)?.ranges.push({ ...r, left: side(r.left), right: side(r.right), place: normalise(r.place) });
  }
  // Trigram → streets, for the fuzzy search.
  const byTri = new Map();
  for (const s of streets.values()) for (const t of s.tri) (byTri.get(t) ?? byTri.set(t, []).get(t)).push(s);
  // A grid of points and ranges for reverse search (0.005° cells). A range goes in every cell its
  // segments pass through, found by stepping along each at half a cell.
  const grid = new Map();
  const cell = (at) => `${Math.floor(at[0] / 0.005)},${Math.floor(at[1] / 0.005)}`;
  const put = (c, item) => (grid.get(c) ?? grid.set(c, []).get(c)).push(item);
  for (const s of streets.values()) {
    for (const p of s.points) put(cell(p.at), { s, p });
    for (const r of s.ranges) {
      const cells = new Set();
      for (let k = 1; k < r.line.length; k++) {
        const [a, b] = [r.line[k - 1], r.line[k]];
        const n = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / 0.0025));
        for (let i = 0; i <= n; i++) cells.add(cell([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]));
      }
      for (const c of cells) put(c, { s, r });
    }
  }
  return { streets, byTri, grid, count: points.length + ranges.length };
}

const rangeHas = (side, n) => {
  if (!side || !side.every(Number.isFinite)) return false;
  const [a, b] = side;
  return n >= Math.min(a, b) && n <= Math.max(a, b) && (a % 2 === b % 2 ? n % 2 === a % 2 : true);
};

/** The best candidate for query `q` among one place's addresses `g` ({points, ranges}) on street `s`. */
function candidate(s, g, q, base) {
  if (Number.isFinite(q.number)) {
    // The number, with its letter when the query or the address has one: 12B is not 12A.
    const same = g.points.filter((p) => p.n === q.number && (!q.suffix || !p.sfx || p.sfx === q.suffix));
    const hit = same.find((p) => p.sfx === q.suffix) ?? same[0];
    if (hit) return { at: hit.at, score: hit.sfx === q.suffix ? base : base * 0.95, match: 'exact', street: s.name, number: hit.number, id: hit.id };
    const r = g.ranges.find((x) => rangeHas(x.left, q.number) || rangeHas(x.right, q.number));
    if (r) {
      const side = rangeHas(r.left, q.number) ? r.left : r.right;
      const f = side[1] === side[0] ? 0.5 : (q.number - side[0]) / (side[1] - side[0]);
      return { at: along(r.line, f), score: base * 0.95, match: 'interpolated', street: s.name, number: String(q.number) + q.suffix.toUpperCase(), id: r.id };
    }
    // The nearest number on the street, lower the further it is.
    const near = g.points.filter((p) => Number.isFinite(p.n)).sort((a, b) => Math.abs(a.n - q.number) - Math.abs(b.n - q.number))[0];
    if (near) return { at: near.at, score: base * Math.max(0.5, 0.9 - Math.abs(near.n - q.number) / 200), match: 'nearest number', street: s.name, number: near.number, id: near.id };
  }
  // The street alone: the middle of its addresses or of its first range.
  const pts = g.points;
  const at = pts.length ? [pts.reduce((a, p) => a + p.at[0], 0) / pts.length, pts.reduce((a, p) => a + p.at[1], 0) / pts.length] : g.ranges.length ? along(g.ranges[0].line, 0.5) : null;
  return at ? { at, score: base * (Number.isFinite(q.number) ? 0.6 : 0.9), match: 'street', street: s.name, number: '', id: null } : null;
}

function searchAs(index, q, fuzzy) {
  let cands = [];
  const exact = index.streets.get(q.street);
  if (exact) cands.push([exact, 1]);
  else {
    const seen = new Map();
    for (const t of trigrams(q.street)) for (const s of index.byTri.get(t) ?? []) seen.set(s, 1);
    cands = [...seen.keys()].map((s) => [s, similarity(q.street, s.key)]).filter(([, v]) => v >= fuzzy);
  }
  const out = [];
  const placeOk = (pl) => !q.rest || !pl || pl === q.rest || pl.includes(q.rest) || q.rest.includes(pl);
  for (const [s, sim] of cands) {
    // One candidate per place the street is in: Main St in two towns is two streets.
    const groups = new Map();
    const group = (pl) => groups.get(pl) ?? groups.set(pl, { points: [], ranges: [] }).get(pl);
    for (const p of s.points) if (placeOk(p.place)) group(p.place).points.push(p);
    for (const r of s.ranges) if (placeOk(r.place)) group(r.place).ranges.push(r);
    // With no place to tell them apart, none of them is certain.
    const k = groups.size > 1 ? 0.9 : 1;
    for (const g of groups.values()) {
      const c = candidate(s, g, q, 100 * sim * k);
      if (c) out.push(c);
    }
  }
  return out;
}

/**
 * Candidates for a query, best first: {at, score (0–100), match ('exact' | 'interpolated' |
 * 'nearest number' | 'street'), street, number, id}. A misspelt street still matches when its
 * similarity is at least `fuzzy` (0.7 takes "4th Stret" for "4th St" but not "Fifth Ave" for "F Ave"); the score falls with the similarity and with a number
 * that had to be approximated. Places named after a comma raise the score of addresses there.
 * A street name in several places gives one candidate for each. A number last is read as part of
 * the street's name ("Route 66") when a street has that whole name, or no street matches without it.
 */
export function search(index, query, { limit = 5, fuzzy = 0.7 } = {}) {
  const q = parseQuery(query);
  if (!q.street) return [];
  const named = { ...q, number: NaN, suffix: '', street: q.whole };
  // "12 B Main St": B is the number's letter when there is a Main St and no B Main St.
  const lettered = q.alt ? { ...q, ...q.alt } : null;
  let out = q.last && index.streets.has(q.whole) ? searchAs(index, named, fuzzy) : lettered && !index.streets.has(q.street) && index.streets.has(lettered.street) ? searchAs(index, lettered, fuzzy) : searchAs(index, q, fuzzy);
  if (!out.length && q.last) out = searchAs(index, named, fuzzy);
  if (!out.length && lettered) out = searchAs(index, lettered, fuzzy);
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The nearest point of segment a–b to p (lon/lat), with its fraction along it and its side (+1 left, −1 right). */
function project(a, b, p) {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const [ax, ay, bx, by, px, py] = [a[0] * k, a[1], b[0] * k, b[1], p[0] * k, p[1]];
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const u = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  const at = [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])];
  return { at, u, side: dx * (py - ay) - dy * (px - ax) >= 0 ? 1 : -1, d: metres(at, p) };
}

/**
 * The address nearest a lon/lat within `max` metres: an address point, or a number interpolated
 * on the side of the nearest street range the point is on. Null when nothing is that near.
 */
export function reverse(index, at, { max = 250 } = {}) {
  const cx = Math.floor(at[0] / 0.005);
  const cy = Math.floor(at[1] / 0.005);
  let best = null;
  const consider = (c) => {
    if (c.d <= max && (!best || c.d < best.d)) best = c;
  };
  const seenR = new Set();
  // Cells are about 555 m by 555 m at the equator and narrower east–west elsewhere: two rings cover `max`.
  const ring = Math.max(1, Math.ceil(max / (0.005 * M_PER_DEG * Math.max(0.2, Math.cos((at[1] * Math.PI) / 180)))));
  for (let i = -ring; i <= ring; i++) {
    for (let j = -ring; j <= ring; j++) {
      for (const it of index.grid.get(`${cx + i},${cy + j}`) ?? []) {
        if (it.p) consider({ d: metres(it.p.at, at), at: it.p.at, street: it.s.name, number: it.p.number, match: 'point', id: it.p.id });
        else if (!seenR.has(it.r)) {
          seenR.add(it.r);
          const r = it.r;
          const total = lineLength(r.line);
          let run = 0;
          for (let k = 1; k < r.line.length; k++) {
            const pr = project(r.line[k - 1], r.line[k], at);
            const f = total > 0 ? (run + pr.u * metres(r.line[k - 1], r.line[k])) / total : 0;
            const side = pr.side > 0 ? r.left : r.right;
            const n = side && side.every(Number.isFinite) ? Math.round(side[0] + f * (side[1] - side[0])) : NaN;
            // Keep the side's parity.
            const num = Number.isFinite(n) && side[0] % 2 === side[1] % 2 && n % 2 !== side[0] % 2 ? n + (side[1] >= side[0] ? 1 : -1) : n;
            consider({ d: pr.d, at: pr.at, street: it.s.name, number: Number.isFinite(num) ? String(num) : '', match: 'interpolated', id: r.id });
            run += metres(r.line[k - 1], r.line[k]);
          }
        }
      }
    }
  }
  return best;
}
