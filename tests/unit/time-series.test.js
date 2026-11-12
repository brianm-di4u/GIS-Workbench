import { describe, expect, it } from 'vitest';
import { baselineFlags, dateFromName, decimalYear, gridCentre, groupsOf, layerDates, nearestSample, profileRows, profileStats } from '../../app/src/analysis/time-series.js';
import { cfTime } from '../../app/src/workers/decode/cf.js';

describe('REQ-GAP-83 dates of a time series', () => {
  it('reads Landsat, Sentinel-2 and MODIS names', () => {
    expect(dateFromName('LC08_L2SP_044034_20200715_20200912_02_T1_SR_B4.TIF')).toBe('2020-07-15T00:00:00Z');
    expect(dateFromName('C:\\data\\LE07_L1TP_044034_20021231_20200916_02_T1_B3.TIF')).toBe('2002-12-31T00:00:00Z');
    expect(dateFromName('LC80440342020197LGN00_B4.TIF')).toBe('2020-07-15T00:00:00Z');
    expect(dateFromName('S2A_MSIL2A_20200715T183921_N0214_R027_T10SFG_20200715T214017.SAFE')).toBe('2020-07-15T18:39:21Z');
    expect(dateFromName('T10SFG_20200715T183921_B04_10m.jp2')).toBe('2020-07-15T18:39:21Z');
    expect(dateFromName('MOD13Q1.A2020193.h08v05.061.2020210112233.hdf')).toBe('2020-07-11T00:00:00Z');
  });
  it('takes one plain date from any name, and refuses two or none or an impossible one', () => {
    expect(dateFromName('ndvi_2019-03-01.tif')).toBe('2019-03-01T00:00:00Z');
    expect(dateFromName('ndvi_20190301_v2.tif')).toBe('2019-03-01T00:00:00Z');
    expect(dateFromName('diff_20190301_20190401.tif')).toBeNull();
    expect(dateFromName('scene_12345678.tif')).toBeNull();
    expect(dateFromName('ndvi_20190230.tif')).toBeNull();
    expect(dateFromName('LC80440342020400LGN00')).toBeNull();
    expect(dateFromName('')).toBeNull();
  });
  it('counts decimal years on the Gregorian calendar', () => {
    expect(decimalYear('2020-01-01')).toBe(2020);
    expect(decimalYear('2020-07-02T00:00:00Z')).toBeCloseTo(2020 + 183 / 366, 12);
    expect(decimalYear('2021-07-02 12:00:00Z')).toBeCloseTo(2021 + 182.5 / 365, 12);
    expect(decimalYear('nope')).toBeNaN();
    // In the date's own calendar: model calendars, and years before 100.
    expect(decimalYear('2001-02-30', '360_day')).toBeCloseTo(2001 + 59 / 360, 12);
    expect(decimalYear('2001-02-29', 'all_leap')).toBeCloseTo(2001 + 59 / 366, 12);
    expect(decimalYear('0099-07-01', 'noleap')).toBeCloseTo(99 + 181 / 365, 12);
    expect(decimalYear('0004-03-01', 'julian')).toBeCloseTo(4 + 60 / 366, 12);
  });
  it('keeps a model-calendar series in order: daily 360_day and all_leap, noleap across year 99', () => {
    const day = (cal, n) => Array.from({ length: n }, (_, i) => ({ time: cfTime('days since 2001-01-01', cal)(i), calendar: cal }));
    expect(layerDates(day('360_day', 360))).toHaveLength(360);
    expect(layerDates(day('all_leap', 366))).toHaveLength(366);
    const across = Array.from({ length: 36 }, (_, i) => ({ time: `${String(98 + Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}-15T00:00:00Z`, calendar: 'noleap' }));
    expect(layerDates(across)).toHaveLength(36);
  });
  it("takes a layer's dates from every band, else from the layer, else none", () => {
    const b = (times) => times.map((time) => ({ name: 'b', time }));
    expect(layerDates(b(['2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z']))).toEqual(['2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z']);
    expect(layerDates(b(['2020-01-01T00:00:00Z', undefined]))).toBeNull();
    expect(layerDates([{}, {}], { timeSeries: { dates: ['2020-01-01', '2021-01-01'] } })).toEqual(['2020-01-01', '2021-01-01']);
    expect(layerDates([{}], { timeSeries: { dates: ['2020-01-01', '2021-01-01'] } })).toBeNull();
    // Time × level bands repeat each date: not a time series. Nor are dates out of order.
    expect(layerDates(b(['2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z', '2020-02-01T00:00:00Z']))).toBeNull();
    expect(layerDates(b(['2020-02-01T00:00:00Z', '2020-01-01T00:00:00Z']))).toBeNull();
  });
  it('groups by calendar month and flags a baseline period', () => {
    const d = ['2010-01-16T00:00:00Z', '2010-07-16T00:00:00Z', '2015-01-16T00:00:00Z'];
    expect(groupsOf(d, 'month')).toEqual([0, 6, 0]);
    expect(groupsOf(d)).toEqual([0, 0, 0]);
    expect(baselineFlags(d, '2010-01-01', '2014-12-31')).toEqual([true, true, false]);
    expect(baselineFlags(d, '', '2010-07-16')).toEqual([true, true, false]);
    expect(baselineFlags(d, '', '')).toEqual([true, true, true]);
  });
});

describe('REQ-GAP-83 temporal profile', () => {
  it('drops only the missing dates of a pixel', () => {
    // Two pixels × three dates; the second pixel is cloudy on date 2.
    const p = profileStats(new Float32Array([1, 2, 3, 3, NaN, 5]), 3);
    expect(p.mean).toEqual([2, 2, 4]);
    expect(p.n).toEqual([2, 1, 2]);
    expect(p.std).toEqual([1, 0, 1]);
    expect(profileStats(new Float32Array([NaN, NaN]), 2).mean.every(Number.isNaN)).toBe(true);
  });
  it('writes CSV rows for a point and for a region', () => {
    expect(profileRows(['2020-01-01', '2020-02-01'], { mean: [0.1, 0.2] })).toEqual([['date', 'value'], ['2020-01-01', 0.1], ['2020-02-01', 0.2]]);
    expect(profileRows(['2020-01-01'], { mean: [0.1], std: [0.01], n: [9] })).toEqual([['date', 'mean', 'std', 'pixels'], ['2020-01-01', 0.1, 0.01, 9]]);
  });
});

describe('REQ-GAP-83 a decimated stack grid', () => {
  it('puts an output pixel where the cube reads it, and takes the nearest source sample', () => {
    // Read every 3 pixels from 10: output pixel 2 is source pixel 16, centred at 16.5 (gw_model_window's
    // to_base(o + 0.5) = 10 + 3·(o + 0.5) − (3 − 1)/2 = 16.5), not at the block centre 17.5.
    expect(gridCentre(10, 3, 2)).toBe(16.5);
    expect(gridCentre(0, 1, 0)).toBe(0.5);
    // At step 1 the nearest sample is the pixel the coordinate falls in.
    expect([3.01, 3.5, 3.99].map((x) => nearestSample(x, 0, 1))).toEqual([3, 3, 3]);
    // At step 3 from 10, samples are source pixels 10, 13, 16: 16.5 is sample 2, and 14.4 is nearer 13 than 16.
    expect(nearestSample(16.5, 10, 3)).toBe(2);
    expect(nearestSample(14.4, 10, 3)).toBe(1);
    expect(nearestSample(15.2, 10, 3)).toBe(2);
    // A same-grid round trip: an output pixel's centre maps back to that output pixel.
    for (const o of [0, 1, 7]) expect(nearestSample(gridCentre(10, 3, o), 10, 3)).toBe(o);
  });
});
