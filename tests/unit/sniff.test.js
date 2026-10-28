// REQ-ING-03: files whose name says nothing are routed by their first bytes.
import { describe, it, expect } from 'vitest';
import { sniffExt } from '../../app/src/formats/sniff.js';

const bytes = (s) => new TextEncoder().encode(s);

describe('content sniffing', () => {
  it('names vector and container formats by content', () => {
    expect(sniffExt('export_2024', bytes('{"type":"FeatureCollection","features":[]}'))).toBe('.geojson');
    expect(sniffExt('doc', bytes('<?xml version="1.0"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">'))).toBe('.kml');
    expect(sniffExt('track', bytes('<?xml version="1.0"?><gpx version="1.1">'))).toBe('.gpx');
    expect(sniffExt('pkg', bytes('SQLite format 3\0more'))).toBe('.gpkg');
    expect(sniffExt('data', new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).toBe('.zip');
    expect(sniffExt('roads', new Uint8Array([0, 0, 0x27, 0x0a, 0, 0]))).toBe('.shp');
    expect(sniffExt('t', bytes('PAR1xxxx'))).toBe('.parquet');
    expect(sniffExt('cloud', bytes('LASF....'))).toBe('.las');
  });
  it('leaves known names and unknown content alone', () => {
    expect(sniffExt('a.geojson', bytes('{"type":"FeatureCollection"}'))).toBe(null);
    expect(sniffExt('noise', bytes('hello world, nothing here'))).toBe(null);
  });
});
