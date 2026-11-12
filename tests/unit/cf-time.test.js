import { describe, expect, it } from 'vitest';
import { cfTime } from '../../app/src/workers/decode/cf.js';

// Expected values from cftime 1.6.5 num2date (tests/tools/cftime_ref.py, gw-te environment).
const CFTIME = [
  ['days since 1970-01-01', 'standard', 0, '1970-01-01T00:00:00Z'],
  ['days since 1970-01-01', 'standard', 19000.5, '2022-01-08T12:00:00Z'],
  ['days since 1970-01-01', 'standard', -1, '1969-12-31T00:00:00Z'],
  ['days since 1970-01-01', 'standard', 36524.25, '2069-12-31T06:00:00Z'],
  ['hours since 1900-01-01 00:00:00', 'gregorian', 0, '1900-01-01T00:00:00Z'],
  ['hours since 1900-01-01 00:00:00', 'gregorian', 1000000, '2014-01-29T16:00:00Z'],
  ['hours since 1900-01-01 00:00:00', 'gregorian', 876600.75, '2000-01-02T00:45:00Z'],
  ['seconds since 2020-01-01T00:00:00Z', 'standard', 1.5, '2020-01-01T00:00:01.500Z'],
  ['seconds since 2020-01-01T00:00:00Z', 'standard', 86399, '2020-01-01T23:59:59Z'],
  ['seconds since 2020-01-01T00:00:00Z', 'standard', 31622400, '2021-01-01T00:00:00Z'],
  ['days since 1582-10-04', 'standard', 0, '1582-10-04T00:00:00Z'],
  ['days since 1582-10-04', 'standard', 1, '1582-10-15T00:00:00Z'],
  ['days since 1582-10-04', 'standard', 10, '1582-10-24T00:00:00Z'],
  ['days since 1500-03-01', 'standard', 0, '1500-03-01T00:00:00Z'],
  ['days since 1500-03-01', 'standard', 100000, '1773-12-24T00:00:00Z'],
  ['days since 1500-03-01', 'proleptic_gregorian', 0, '1500-03-01T00:00:00Z'],
  ['days since 1500-03-01', 'proleptic_gregorian', 100000, '1773-12-14T00:00:00Z'],
  ['days since 0001-01-01', 'julian', 0, '0001-01-01T00:00:00Z'],
  ['days since 0001-01-01', 'julian', 730000, '1999-08-20T00:00:00Z'],
  ['days since 2000-01-01', 'noleap', 59, '2000-03-01T00:00:00Z'],
  ['days since 2000-01-01', 'noleap', 365, '2001-01-01T00:00:00Z'],
  ['days since 2000-01-01', 'noleap', 3650, '2010-01-01T00:00:00Z'],
  ['days since 2000-01-01', '365_day', 59, '2000-03-01T00:00:00Z'],
  ['days since 2000-01-01', 'all_leap', 59, '2000-02-29T00:00:00Z'],
  ['days since 2000-01-01', 'all_leap', 366, '2001-01-01T00:00:00Z'],
  ['days since 2000-01-01', 'all_leap', 3660, '2010-01-01T00:00:00Z'],
  ['days since 2000-01-01', '360_day', 29, '2000-01-30T00:00:00Z'],
  ['days since 2000-01-01', '360_day', 59, '2000-02-30T00:00:00Z'],
  ['days since 2000-01-01', '360_day', 359, '2000-12-30T00:00:00Z'],
  ['days since 2000-01-01', '360_day', 3600, '2010-01-01T00:00:00Z'],
  ['minutes since 2010-06-30 23:00', 'standard', 59, '2010-06-30T23:59:00Z'],
  ['minutes since 2010-06-30 23:00', 'standard', 61, '2010-07-01T00:01:00Z'],
  ['minutes since 2010-06-30 23:00', 'standard', 525600, '2011-06-30T23:00:00Z'],
  ['days since 2000-01-01 00:00:00 -06:00', 'standard', 0, '2000-01-01T06:00:00Z'],
  ['days since 2000-01-01 00:00:00 -06:00', 'standard', 0.25, '2000-01-01T12:00:00Z'],
  ['days since 2000-01-01T00:00:00+05:30', 'standard', 0, '1999-12-31T18:30:00Z'],
  ['days since 2000-01-01T00:00:00+05:30', 'standard', 1, '2000-01-01T18:30:00Z'],
];

describe('REQ-GAP-83 CF time units decode to ISO dates', () => {
  it('matches cftime on every CF calendar', () => {
    for (const [units, cal, v, iso] of CFTIME) expect(cfTime(units, cal)(v), `${units} ${cal} ${v}`).toBe(iso);
  });
  it('gives every day of a noleap and an all_leap year as cftime does', () => {
    // Day numbers of each month start from 2001-01-01, and of the next year, from cftime 1.6.5
    // (tests/tools/cftime_ref.py MONTH_STARTS). Every day between follows from them.
    const STARTS = { noleap: [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365], all_leap: [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366] };
    for (const [cal, s] of Object.entries(STARTS)) {
      const f = cfTime('days since 2001-01-01', cal);
      for (let v = 0; v <= s[12]; v++) {
        const m = s.findLastIndex((x) => x <= v);
        const want = m === 12 ? '2002-01-01' : `2001-${String(m + 1).padStart(2, '0')}-${String(v - s[m] + 1).padStart(2, '0')}`;
        expect(f(v), `${cal} ${v}`).toBe(`${want}T00:00:00Z`);
      }
    }
  });
  it('counts months and years since as calendar months, so a monthly axis stays in its months', () => {
    const iso = (u, cal, vs) => vs.map((v) => cfTime(u, cal)(v));
    expect(iso('months since 2000-01-01', 'standard', [0, 1, 2, 11, 12, 13])).toEqual(['2000-01-01', '2000-02-01', '2000-03-01', '2000-12-01', '2001-01-01', '2001-02-01'].map((d) => `${d}T00:00:00Z`));
    expect(iso('months since 2000-01-15 12:00', 'noleap', [1, 25])).toEqual(['2000-02-15T12:00:00Z', '2002-02-15T12:00:00Z']);
    expect(iso('years since 2000-01-01', 'standard', [1, 0.5, -1])).toEqual(['2001-01-01T00:00:00Z', '2000-07-01T00:00:00Z', '1999-01-01T00:00:00Z']);
    // A day past the end of a short month is its last day; a fraction is of the month it lands in.
    expect(iso('months since 2000-01-31', 'standard', [1])).toEqual(['2000-02-29T00:00:00Z']);
    expect(iso('months since 2000-02-01', 'standard', [0.5])).toEqual(['2000-02-15T12:00:00Z']);
    expect(iso('months since 2000-01-01', '360_day', [1, 13.5])).toEqual(['2000-02-01T00:00:00Z', '2001-02-16T00:00:00Z']);
  });
  it("takes CF's own example of a one-digit zone offset, which cftime ignores", () => {
    expect(cfTime('days since 1990-1-1 0:0:0 -6:00')(0)).toBe('1990-01-01T06:00:00Z');
  });
  it('reads the calendar names case-blind, and an empty one as standard', () => {
    expect(cfTime('days since 2000-01-01', 'NOLEAP')(59)).toBe('2000-03-01T00:00:00Z');
    expect(cfTime('days since 2000-01-01', '')(59)).toBe('2000-02-29T00:00:00Z');
    expect(cfTime('days since 2000-01-01', undefined)(59)).toBe('2000-02-29T00:00:00Z');
  });
  it('is null for units that are not a time, and for calendars it does not know', () => {
    expect(cfTime('metres')).toBeNull();
    expect(cfTime('bananas since 2000-01-01')).toBeNull();
    expect(cfTime('days since 2000-01-01', 'none')).toBeNull();
    expect(cfTime('days since 2000-01-01', 'mayan')).toBeNull();
    expect(cfTime('days since 2000-01-01')(NaN)).toBeNull();
  });
});
