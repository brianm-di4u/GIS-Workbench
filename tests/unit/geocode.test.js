import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { along, buildIndex, houseNumber, metres, normalise, parseQuery, reverse, search, similarity } from '../../app/src/analysis/geocode.js';

// A small town: address points on Main Street, a numbered range on Oak Avenue running east.
const MAIN = (n, lon) => ({ id: `m${n}`, number: String(n), street: 'Main Street', place: 'Springfield', at: [lon, 40] });
const POINTS = [MAIN(1, -105.0), MAIN(3, -104.999), MAIN(5, -104.998), MAIN(2, -105.0), { id: 'r1', number: '12A', street: "Rue de l'Église", place: 'Lyon', at: [4.83, 45.76] }];
const RANGES = [{ id: 'oak1', street: 'Oak Avenue', place: 'Springfield', line: [[-105.01, 40.01], [-105.0, 40.01]], left: [101, 199], right: [100, 198] }];
const IX = buildIndex({ points: POINTS, ranges: RANGES });

describe('REQ-GAP-85 address normalising and parsing', () => {
  it('normalises case, accents, punctuation, street types and directions', () => {
    expect(normalise("Rue de l'Église")).toBe('rue de l eglise');
    expect(normalise('  North MAIN Street ')).toBe('n main st');
    expect(normalise('Oak Ave.')).toBe('oak ave');
    expect(normalise(null)).toBe('');
    expect(normalise('Fifth Avenue')).toBe('5th ave');
  });
  it('reads the house number first or last, and the place after a comma', () => {
    expect(parseQuery('221B Baker Street, London')).toEqual({ number: 221, suffix: 'b', street: 'baker st', rest: 'london', last: false, whole: '221b baker st' });
    expect(parseQuery('Baker Street 221')).toEqual({ number: 221, suffix: '', street: 'baker st', rest: '', last: true, whole: 'baker st 221' });
    expect(parseQuery('Baker Street')).toMatchObject({ street: 'baker st' });
    expect(Number.isNaN(parseQuery('Baker Street').number)).toBe(true);
    expect(houseNumber('12-14')).toBe(12);
  });
  // #266: Portuguese and Russian write the number after its own comma, Hungarian with a dot.
  it('reads a number in its own segment after the street, and an ordinal dot', () => {
    expect(parseQuery('Rua Principal, 12, Lisboa')).toEqual({ number: 12, suffix: '', street: 'rua principal', rest: 'lisboa', last: false, whole: 'rua principal', asPlace: '12 lisboa' });
    expect(parseQuery('Rua Principal, 12A, Lisboa')).toMatchObject({ number: 12, suffix: 'a', rest: 'lisboa' });
    expect(parseQuery('Fő utca 12., Újfalu')).toMatchObject({ number: 12, street: 'fo utca', rest: 'ujfalu', last: true });
    // The short form, with no place after the number (#292), reads the same way.
    expect(parseQuery('Rua Principal, 12')).toMatchObject({ number: 12, street: 'rua principal', rest: '' });
    expect(parseQuery('Rua Principal, 12A')).toMatchObject({ number: 12, suffix: 'a', rest: '' });
    expect(parseQuery('ул. Ленина, 12/3')).toMatchObject({ number: 12, suffix: '', rest: '' });
    // A longer lone number may be a postcode: it stays the place.
    expect(parseQuery('Main Street, 10115')).toMatchObject({ street: 'main st', rest: '10115' });
    expect(Number.isNaN(parseQuery('Main Street, 10115').number)).toBe(true);
    // … and so do five digits, a leading zero and a postcode's hyphen with a place after them.
    for (const q of ['Main Street, 62701, USA', 'Main Street, 0150, Oslo', 'Marszałkowska, 00-950, Warszawa', 'Rua Principal, 1000-001, Lisboa', 'Rua Principal, 1000–001., Lisboa']) {
      expect(parseQuery(q), q).toMatchObject({ number: NaN, rest: normalise(q.split(',').slice(1).join(' ')) });
    }
    expect(parseQuery('ул. Ленина, 12/3, Москва')).toMatchObject({ number: 12, rest: 'москва' });
    // Up to 4 digits are a house number; a bare one keeps the postcode reading in `asPlace` (decision 0025).
    expect(parseQuery('Avenida Paulista, 1578, São Paulo')).toMatchObject({ number: 1578, rest: 'sao paulo', asPlace: '1578 sao paulo' });
    expect(parseQuery('Rua Principal, 12A, Lisboa').asPlace).toBeUndefined();
    expect(parseQuery('ул. Ленина, 12/3, Москва').asPlace).toBeUndefined();
    // Both forms find the house, as the English order does, and so does the short form.
    for (const q of ['Main Street, 3, Springfield', 'Main Street 3., Springfield', 'Main Street, 3']) expect(search(IX, q)[0]?.id, q).toBe('m3');
  });
  // #301, decision 0025: a bare number after the street's comma is a house number or a postcode;
  // search ranks a house the street holds first, the street read with the postcode next, and a
  // nearest-house guess last.
  it('ranks the house-number and postcode readings of a number after the comma', () => {
    const at = (c) => [c.match, c.number, c.at];
    // A point, and a 4-digit one: the house first.
    const towns = buildIndex({ points: [MAIN(3, -105), { ...MAIN(5, -90), id: 's5', place: 'Shelbyville' }, MAIN(1578, -105.01)] });
    expect(search(towns, 'Main Street, 1578, Springfield')[0]).toMatchObject({ match: 'exact', id: 'm1578' });
    expect(search(IX, 'Main Street, 3, Springfield')[0]).toMatchObject({ match: 'exact', id: 'm3' });
    // A range: the interpolated house first.
    expect(search(IX, 'Oak Avenue, 150, Springfield')[0]).toMatchObject({ match: 'interpolated', number: '150' });
    // A number the street does not hold: its street first, then the nearest house, lower.
    const r = search(IX, 'Main Street, 101, Springfield');
    expect(r.map((c) => c.match)).toEqual(['street', 'nearest number']);
    expect(r[0].at).toEqual(search(IX, 'Main Street, Springfield')[0].at);
    // A postcode-named index: the district the postcode names.
    const districts = buildIndex({ points: [5, 7].map((n) => ({ id: `a${n}`, number: String(n), street: 'Hauptstraße', place: '1010', at: [16.37, 48.21] })).concat([5, 9].map((n) => ({ id: `b${n}`, number: String(n), street: 'Hauptstraße', place: '1210', at: [16.4, 48.27] }))) });
    expect(at(search(districts, 'Hauptstraße, 1210')[0])).toEqual(['street', '', [16.4, 48.27]]);
    // A multi-word place named by its first word: still that place's street, not every town's.
    const two = buildIndex({ points: [{ ...MAIN(3, -105), place: 'Springfield IL' }, { ...MAIN(5, -105.001), place: 'Springfield IL' }, { ...MAIN(3, -90), id: 's3', place: 'Shelbyville' }] });
    expect(search(two, 'Main Street, 99, Springfield').map((c) => c.match)).toEqual(['street', 'nearest number']);
    // The short form with no place: the street in each town, never 'other place' (no place was named).
    expect(search(two, 'Main Street, 101').map((c) => c.match)).not.toContain('other place');
    expect(search(two, 'Main Street, 3')[0]).toMatchObject({ match: 'exact', number: '3' });
    // A lettered number has one reading, the house: the nearest house, with no postcode street.
    expect(search(IX, 'Main Street, 4B, Springfield').map((c) => c.match)).toEqual(['nearest number']);
    // The postcode reading keeps the place after the number when the index holds no place with the
    // number in it: "99, Springfield" gives the same streets as "Springfield" alone.
    const springs = buildIndex({ points: [{ ...MAIN(5, -90), id: 'p5' }, { ...MAIN(7, -89.6), id: 'q7', place: 'Springfield IL' }] });
    const streets = (q) => search(springs, q).filter((c) => c.match === 'street').map((c) => c.at);
    expect(streets('Main Street, 99, Springfield')).toEqual(streets('Main Street, Springfield'));
    expect(streets('Main Street, 99, Springfield')).toHaveLength(2);
    // "Hauptstraße, 1010, Wien" with Wien in the index: Wien's street, not Graz's.
    const towns2 = buildIndex({ points: [{ id: 'w7', number: '7', street: 'Hauptstraße', place: 'Wien', at: [16.37, 48.21] }, { id: 'g7', number: '7', street: 'Hauptstraße', place: 'Graz', at: [15.44, 47.07] }] });
    const wien = search(towns2, 'Hauptstraße, 1010, Wien');
    expect(wien[0]).toMatchObject({ match: 'street', at: [16.37, 48.21] });
    // The street and the nearest house share a point but are different results: both stay.
    expect(wien.map((c) => c.match)).toEqual(['street', 'nearest number']);
    // A postcode-named index with a city after the postcode: the district, ahead of any other.
    expect(search(districts, 'Hauptstraße, 1210, Wien')[0]).toMatchObject({ match: 'street', at: [16.4, 48.27] });
    expect(wien.some((c) => c.id === 'g7' || (c.at[0] === 15.44 && c.at[1] === 47.07))).toBe(false);
    // Both readings can land on the same street: it is listed once.
    const elm = buildIndex({ points: [{ id: 'e', number: '', street: 'Elm Road', place: 'Springfield', at: [-100, 40] }] });
    expect(search(elm, 'Elm Road, 7').map((c) => c.match)).toEqual(['street']);
    // An unknown place (a postcode, a misspelling) hides nothing: a house the street holds is first.
    for (const q of ['Main Street, 3, 62701', 'Main Street, 3, Springfeld']) expect(search(IX, q)[0], q).toMatchObject({ number: '3', id: 'm3' });
  });
  // #266: Find Address shows "12 Main Street, Springfield" as its example; every locale's example
  // must be one the parser reads, house number 12 on a street, in a place.
  it("reads every locale's example address as number 12 on a street, in a place", () => {
    const dir = join('app', 'src', 'i18n', 'catalog');
    const wrong = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'en.json')) {
      const ex = JSON.parse(readFileSync(join(dir, f), 'utf8')).messages['12 Main Street, Springfield'];
      if (!ex) continue;
      const q = parseQuery(ex);
      if (q.number !== 12 || !q.street || !q.rest) wrong.push(`${f.slice(0, -5)}: ${ex} → ${q.number}, "${q.street}", "${q.rest}"`);
    }
    expect(wrong).toEqual([]);
  });
  it('scores near misses by trigram similarity', () => {
    expect(similarity('main st', 'main st')).toBe(1);
    expect(similarity('main st', 'mian st')).toBeCloseTo(1 - 1 / 7, 9); // one transposition
    expect(similarity('main st', 'st main')).toBe(0.95); // words swapped
    expect(similarity('main st', 'oak ave')).toBeLessThan(0.2);
    expect(similarity('4th st', '5th st')).toBe(0);
    expect(similarity('5th ave', 'h ave')).toBe(0);
    expect(similarity('4th stret', '4th st')).toBeGreaterThan(0.7);
  });
});

describe('REQ-GAP-85 forward geocoding', () => {
  it('finds an exact address', () => {
    const [r] = search(IX, '3 Main St');
    expect(r).toMatchObject({ match: 'exact', number: '3', street: 'Main Street', score: 100 });
    expect(r.at).toEqual([-104.999, 40]);
  });
  it('finds a misspelt street at a lower score', () => {
    const [r] = search(IX, '3 Mian Street');
    expect(r.match).toBe('exact');
    expect(r.score).toBeLessThan(100);
    expect(r.score).toBeGreaterThan(50);
  });
  it('interpolates along a range on the side of the number', () => {
    const [even] = search(IX, '150 Oak Avenue');
    // 150 is even: the right side 100–198, half way.
    expect(even.match).toBe('interpolated');
    expect(even.at[0]).toBeCloseTo(-105.01 + 0.01 * (50 / 98), 9);
    expect(even.at[1]).toBeCloseTo(40.01, 9);
    const [first] = search(IX, '101 Oak Ave');
    expect(first.at[0]).toBeCloseTo(-105.01, 9);
  });
  it('falls back to the nearest number, then to the street', () => {
    const [n] = search(IX, '7 Main Street');
    expect(n).toMatchObject({ match: 'nearest number', number: '5' });
    const [s] = search(IX, 'Main Street');
    expect(s.match).toBe('street');
    expect(search(IX, 'Nowhere Lane')).toEqual([]);
    // A different street that only looks alike is not taken: Oak Avenue is not Main Street.
    expect(search(IX, '3 Oak Street')[0]?.street).not.toBe('Main Street');
  });
  it('keeps a place the index holds, and ranks by one it does not', () => {
    expect(search(IX, "12 rue de l'eglise, Lyon")[0]).toMatchObject({ match: 'exact', id: 'r1' });
    // A place the index does not have (a town it lacks, a postcode) hides nothing: lower, and marked.
    expect(search(IX, '3 Main Street, Shelbyville')[0]).toMatchObject({ id: 'm3', match: 'other place' });
    expect(search(IX, '3 Main Street, Shelbyville')[0].score).toBeLessThanOrEqual(70);
    expect(search(IX, '3 Main Street, 62701')[0]).toMatchObject({ id: 'm3', match: 'other place' });
    // A place it has (Lyon) keeps the addresses there only: Main Street is in Springfield.
    expect(search(IX, '3 Main Street, Lyon')).toEqual([]);
    // Places are compared by whole words: IL is not in Shelbyville, and Springfield IL is Springfield.
    const il = buildIndex({ points: [...POINTS, { id: 'o1', number: '1', street: 'Oak St', place: 'Shelbyville', at: [-90, 35] }] });
    expect(search(il, '3 Main Street, IL')[0]).toMatchObject({ id: 'm3', match: 'other place' });
    expect(search(il, '3 Main Street, Springfield IL')[0]).toMatchObject({ id: 'm3', match: 'exact' });
  });
  it('gives one candidate per town for a street name in two, and none of them certain', () => {
    const two = buildIndex({ points: [...POINTS, { id: 's3', number: '3', street: 'Main St', place: 'Shelbyville', at: [-90, 35] }] });
    const all = search(two, '3 Main Street');
    expect(all.map((c) => c.id).sort()).toEqual(['m3', 's3']);
    expect(all.every((c) => c.score < 100)).toBe(true);
    expect(search(two, '3 Main Street, Shelbyville')).toEqual([expect.objectContaining({ id: 's3', score: 100 })]);
    // The street alone is never a point between the two towns.
    expect(search(two, 'Main Street').map((c) => Math.round(c.at[0]))).toEqual(expect.arrayContaining([-105, -90]));
  });
  it('keeps the letter of a house number: 12B is not 12A', () => {
    expect(search(IX, "12A rue de l'eglise")[0]).toMatchObject({ match: 'exact', id: 'r1' });
    expect(search(IX, "12B rue de l'eglise")[0].match).toBe('nearest number');
    expect(search(IX, "12 rue de l'eglise")[0]).toMatchObject({ match: 'exact', id: 'r1' });
  });
  it('reads hyphenated and spaced house numbers, and keeps a direction in the street', () => {
    expect(parseQuery('12-14 Main Street')).toMatchObject({ number: 12, suffix: '', street: 'main st' });
    expect(parseQuery('12 B Main Street')).toMatchObject({ number: 12, suffix: '', street: 'b main st', alt: { suffix: 'b', street: 'main st' } });
    expect(parseQuery('12 N Main Street')).toMatchObject({ number: 12, suffix: '', street: 'n main st' });
    expect(parseQuery('12 N Main Street').alt).toBeUndefined();
    // B is the number's letter when there is a Main Street and no B Main Street; a C Avenue keeps its C.
    expect(search(IX, '3 B Main Street')[0]).toMatchObject({ id: 'm3', match: 'exact' });
    const cav = buildIndex({ points: [{ id: 'c', number: '502', street: 'C Avenue', at: [-105, 40] }, { id: 'a', number: '502', street: 'Avenue', at: [-104, 40] }] });
    expect(search(cav, '502 C Avenue')[0]).toMatchObject({ id: 'c', score: 100 });
    expect(parseQuery('Main Street 12-14')).toMatchObject({ number: 12, street: 'main st', last: true });
    expect(search(IX, '1-3 Main Street')[0]).toMatchObject({ id: 'm1', match: 'exact' });
    expect(search(IX, 'Main Street 3–5')[0]).toMatchObject({ id: 'm3', match: 'exact' });
  });
  it('reads a number last as part of the street when that is the street', () => {
    const hwy = buildIndex({ points: [{ id: 'h', number: '400', street: 'Highway 101', at: [-120, 36] }, { id: 'r', number: '66', street: 'Elm St', at: [-120.1, 36] }] });
    expect(search(hwy, 'Highway 101')[0]).toMatchObject({ street: 'Highway 101', match: 'street' });
    expect(search(hwy, '400 Highway 101')[0]).toMatchObject({ id: 'h', match: 'exact' });
    // Not when a street has the name without it.
    expect(search(hwy, 'Elm Street 66')[0]).toMatchObject({ id: 'r', match: 'exact' });
  });
});

describe('REQ-GAP-85 reverse geocoding', () => {
  it('gives the nearest address point', () => {
    const r = reverse(IX, [-104.99901, 40.00002]);
    expect(r).toMatchObject({ match: 'point', number: '3', street: 'Main Street' });
    expect(r.d).toBeLessThan(5);
  });
  it('interpolates a number on the side of a range the point is on', () => {
    // North of Oak Avenue (running east) is its left: odd numbers 101–199. A quarter of the way along.
    const north = reverse(IX, [-105.0075, 40.0102]);
    expect(north.match).toBe('interpolated');
    expect(Number(north.number) % 2).toBe(1);
    expect(Number(north.number)).toBeGreaterThanOrEqual(123);
    expect(Number(north.number)).toBeLessThanOrEqual(127);
    const south = reverse(IX, [-105.0075, 40.0098]);
    expect(Number(south.number) % 2).toBe(0);
  });
  it('finds nothing beyond the distance', () => {
    expect(reverse(IX, [-100, 30])).toBeNull();
  });
  it('finds the middle of a long range far from its vertices', () => {
    // A 3 km road with two vertices; the point is 50 m north of its middle.
    const long = buildIndex({ ranges: [{ id: 'l', street: 'Long Rd', line: [[-105.0, 41.0], [-104.9645, 41.0]], left: [1, 99], right: [2, 100] }] });
    expect(reverse(long, [-104.98225, 41.00045])).toMatchObject({ id: 'l', match: 'interpolated', number: '51' });
  });
  it('gives no number for a side without numbers, blank or 0 to 0', () => {
    const blank = buildIndex({ ranges: [{ id: 'b', street: 'Blank Rd', line: [[-105, 42], [-104.99, 42]], left: [NaN, NaN], right: [0, 0] }] });
    expect(reverse(blank, [-104.995, 42.0002])).toMatchObject({ id: 'b', number: '' });
    expect(reverse(blank, [-104.995, 41.9998])).toMatchObject({ id: 'b', number: '' });
  });
});

describe('REQ-GAP-85 geometry helpers', () => {
  it('measures and walks a line', () => {
    expect(metres([0, 0], [0, 1])).toBeCloseTo(111320, 0);
    expect(along([[0, 0], [1, 0], [1, 1]], 0.75)).toEqual([1, 0.5]);
  });
});
