// Texts kept in English in records and shown in the UI language (2.3 integration, DN-62 L0/L5):
// Mensuration Log methods, model names, attribute checks with codes, report CRS descriptions,
// 3D Tiles validation errors and the pack-required message.
import { describe, it, expect, afterEach } from 'vitest';
import { setLocale, msgOf } from '../../app/src/i18n/index.js';
import { menText, menRow } from '../../app/src/tools/menlog.js';
import { modelLabel } from '../../app/src/formats/model-names.js';
import { parseB3dm } from '../../app/src/render/tiles3d-content.js';
import { mbtilesTooLarge, mbtilesTooLargeError, MBTILES_CAP } from '../../app/src/formats/mbtiles.js';
import { errorText } from '../../app/src/core/util.js';

const DE = (pairs) => ({ keys: pairs.map((p) => p[0]), values: pairs.map((p) => p[1]) });

afterEach(() => setLocale('en'));

describe('Mensuration Log texts', () => {
  it('stay as they are in English', () => {
    const s = 'Mono height by shadow on flat ground: h = L·tan(e); L 12.30 m along azimuth 4.00°; sun az 1.00°, el 3.20° (metadata)';
    expect(menText(s)).toBe(s);
    expect(menText('38SMB 12345 67890')).toBe('38SMB 12345 67890');
  });
  it('are translated part by part, with locale numbers, and the record and CSV stay English', () => {
    setLocale('de', DE([['Mono-DEM', 'Mono-DGM'], ['geodesic (Karney 2013, WGS 84)', 'geodätisch (Karney 2013, WGS 84)'], ['L {length} m along azimuth {azimuth}°', 'L {length} m entlang Azimut {azimuth}°'], ['Point', 'Punkt'], ['absolute', 'absolut']]));
    expect(menText('Mono-DEM; geodesic (Karney 2013, WGS 84)')).toBe('Mono-DGM; geodätisch (Karney 2013, WGS 84)');
    expect(menText('L 12.30 m along azimuth 4.00°')).toBe('L 12,30 m entlang Azimut 4,00°');
    const m = { mid: 'M-01', mtype: 'Point', value: '38SMB', units: 'MGRS', method: 'Mono-DEM', tag: 'absolute', heightSource: 'SRTM' };
    expect(menRow(m)).toMatchObject({ type: 'Punkt', method: 'Mono-DGM', tag: 'absolut', heightSource: 'SRTM', units: 'MGRS' });
    expect(menRow(m, { machine: true })).toMatchObject({ type: 'Point', method: 'Mono-DEM', tag: 'absolute' });
    expect(m.method).toBe('Mono-DEM');
  });
  it('en-XA marks each translated part once', () => {
    setLocale('en-XA');
    const s = menText('Mono-DEM; geodesic (Karney 2013, WGS 84)');
    expect(s.split('; ').every((p) => p.startsWith('⟦') && p.endsWith('⟧'))).toBe(true);
    expect(s).not.toMatch(/⟦⟦/);
  });
});

describe('model names', () => {
  it('match the most specific template; product names stay', () => {
    expect(modelLabel('RPC00B')).toBe('RPC00B');
    expect(modelLabel('GCPs (12, GeoTIFF)')).toBe('GCPs (12, GeoTIFF)');
    setLocale('de', DE([['GCPs ({n}, GeoTIFF)', 'GCPs ({n}, GeoTIFF-Tag)'], ['GCPs ({n}, {crs})', 'GCPs ({n}, KBS {crs})'], ['{map} ({crs}, fitted)', '{map} ({crs}, angepasst)'], ['Map (world file)', 'Karte (World-Datei)']]));
    expect(modelLabel('GCPs (12, GeoTIFF)')).toBe('GCPs (12, GeoTIFF-Tag)');
    expect(modelLabel('GCPs (12, EPSG:32611)')).toBe('GCPs (12, KBS EPSG:32611)');
    expect(modelLabel('Map (world file) (EPSG:32611, fitted)')).toBe('Karte (World-Datei) (EPSG:32611, angepasst)');
  });
});

describe('errors keep their English message and show translated', () => {
  it('3D Tiles validation', () => {
    const b = new Uint8Array(20);
    b.set([0x62, 0x33, 0x64, 0x6d]);
    let e;
    try {
      parseB3dm(b);
    } catch (x) {
      e = x;
    }
    expect(e.code).toBe('E_TILE_INVALID');
    expect(e.message).toMatch(/^3D Tiles b3dm: tile is 20 bytes, shorter than its 28-byte header$/);
    setLocale('de', DE([['tile is {size} bytes, shorter than its {head}-byte header', 'Kachel hat {size} Bytes, weniger als ihr {head}-Byte-Kopf']]));
    expect(msgOf(e)).toMatch(/: Kachel hat 20 Bytes, weniger als ihr 28-Byte-Kopf$/);
  });
  it('MBTiles too large', () => {
    const e = mbtilesTooLargeError(MBTILES_CAP + 2 ** 20);
    expect(e.message).toBe(mbtilesTooLarge(MBTILES_CAP + 2 ** 20));
    expect(e.code).toBe('E_MBTILES_TOO_LARGE');
    expect(e.i18n.src).toMatch(/\{mb\} MB MBTiles file/);
  });
  it('errorText in English for code that matches it', () => {
    const e = new RangeError('Offset is outside the bounds of the DataView');
    expect(errorText(e, { english: true })).toBe('the file is cut short or damaged: it ends before the data it describes');
    setLocale('en-XA');
    expect(errorText(e, { english: true })).toBe('the file is cut short or damaged: it ends before the data it describes');
    expect(errorText(e)).toMatch(/^⟦/);
  });
});
