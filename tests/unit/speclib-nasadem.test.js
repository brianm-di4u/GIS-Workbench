// CX-088 (NASADEM .num/.swb grouped as sidecars of the .hgt), CX-089 (ECOSTRESS / ASTER library text) and
// CX-090 (KML documents linked inside a KMZ).
import { describe, it, expect } from 'vitest';
import { groupFiles } from '../../app/src/formats/open.js';
import { kmlLinks } from '../../app/src/vector/io.js';

describe('CX-090 KMZ NetworkLinks', () => {
  it('lists local linked KML documents relative to the linking file, skipping web links', () => {
    const doc = '<kml><Document><NetworkLink><name>image</name><Link><href>overlay.kml</href></Link></NetworkLink>' +
      '<NetworkLink><Link><href> sub/../border.kml </href></Link></NetworkLink>' +
      '<NetworkLink><Link><href>http://example.com/live.kml</href></Link></NetworkLink>' +
      '<NetworkLink><Link><href>tiles/x.png</href></Link></NetworkLink></Document></kml>';
    expect(kmlLinks(doc)).toEqual(['overlay.kml', 'border.kml']);
    expect(kmlLinks(doc, 'files/')).toEqual(['files/overlay.kml', 'files/border.kml']);
  });
});
import { parseSpecLibText } from '../../app/src/formats/speclib.js';

const file = (name) => ({ name, size: 10 });

describe('CX-088 NASADEM ancillary grids', () => {
  it('groups n39w106.num and .swb with n39w106.hgt instead of opening them as images', () => {
    const g = groupFiles(['n39w106.hgt', 'n39w106.num', 'n39w106.swb'].map(file));
    expect(g.map((x) => x.file.name)).toEqual(['n39w106.hgt']);
    expect(g[0].sidecars.map((s) => s.name).sort()).toEqual(['n39w106.num', 'n39w106.swb']);
  });
});

const ECO = [
  'Name: Rhyolite',
  'Type: Rock',
  'Sample No.: AP-937-168',
  'Measurement: Directional Hemispherical Reflectance',
  'X Units: Wavelength (micrometers)',
  'Y Units:Reflectance (percent)',
  'Number of X Values: 3',
  '',
  '14.0510\t 2.0806',
  ' 2.2000\t50.0000',
  ' 0.4050\t37.8029',
  '',
].join('\r\n');

describe('CX-089 ECOSTRESS spectrum text', () => {
  it('reads the name, sorts wavelengths ascending and scales percent to 0-1', () => {
    const s = parseSpecLibText(ECO, 'rock.spectrum.txt');
    expect(s.name).toBe('Rhyolite (AP-937-168)');
    expect(s.wl).toEqual([0.405, 2.2, 14.051]);
    expect(s.values.map((v) => +v.toFixed(6))).toEqual([0.378029, 0.5, 0.020806]);
    expect(s.source).toBe('rock.spectrum.txt');
  });
  it('converts nanometres to micrometres', () => {
    const s = parseSpecLibText(ECO.replace('micrometers', 'nanometers').replace('14.0510', '1400').replace(' 2.2000', '900').replace(' 0.4050', '400'), 'x');
    expect(s.wl).toEqual([0.4, 0.9, 1.4]);
  });
  it('returns null for CSV and USGS ASCII text', () => {
    expect(parseSpecLibText('wavelength,a\n0.4,0.1\n0.5,0.2\n')).toBeNull();
    expect(parseSpecLibText('splib07a Record=1: Alunite\n0.1\n0.2\n')).toBeNull();
  });
});
