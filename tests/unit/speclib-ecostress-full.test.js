// CX-094 (ECOSTRESS transmittance spectra tagged, left out of matching), CX-095 (Latin-1 library text) and
// CX-096 (ENVI FWHM unit) and IMP-26 (library browser ranking) from the full ECOSTRESS library (3,451
// spectra, 2026-11-02).
import { describe, it, expect } from 'vitest';
import { parseSpecLibText, decodeLibraryText, spectrumQuantity, resampleSpectrum, spectralAngle, rankLibrary } from '../../app/src/formats/speclib.js';
import { enviBands } from '../../app/src/workers/decode/envi.js';

const eco = (name, yUnits, measurement, rows) =>
  [`Name: ${name}`, 'Type: Mineral', 'Class: Silicate', 'Subclass: Inosilicate', 'Sample No.: X1', `Measurement: ${measurement}`, 'Origin: 34.7157; -120.0601; WGS84', 'X Units: Wavelength (micrometers)', `Y Units: ${yUnits}`, '', ...rows.map(([x, y]) => ` ${x}\t ${y}`), ''].join('\r\n');

describe('CX-094 spectrum quantity', () => {
  it('reads every Y units / measurement spelling in the ECOSTRESS library', () => {
    expect(spectrumQuantity('Reflectance (percent)', 'Hemispherical reflectance')).toBe('reflectance');
    expect(spectrumQuantity('Reflectance (percentage)', 'Bidirectional reflectance')).toBe('reflectance');
    expect(spectrumQuantity('Reflectence (percent)', 'Reflectance')).toBe('reflectance');
    for (const [y, m] of [['Transmittance (percent)', 'Transmission'], ['Transmittence (percent)', 'Transmission'], ['transmittance (percent)', 'transmission'], ['Transittance (percent)', 'Transmission'], ['Transmission (percent)', 'Tansmission']]) expect(spectrumQuantity(y, m)).toBe('transmittance');
    expect(spectrumQuantity('Emissivity', '')).toBe('emissivity');
    expect(spectrumQuantity('', '')).toBe('unknown');
  });
  it('tags the parsed spectrum and keeps type, class and origin', () => {
    const s = parseSpecLibText(eco('Augite', 'Transmittance (percent)', 'Transmission', [[2.5, 40], [2.0, 50]]), 'm.spectrum.txt');
    expect(s.quantity).toBe('transmittance');
    expect(s.meta).toEqual({ type: 'Mineral', class: 'Silicate / Inosilicate', measurement: 'Transmission', origin: { lat: 34.7157, lon: -120.0601 } });
  });
});

describe('CX-095 Latin-1 library text', () => {
  it('decodes the 0xB7 middle dot instead of U+FFFD', () => {
    const bytes = Uint8Array.from([...'Name: Natron Na2CO3'].map((c) => c.charCodeAt(0)).concat([0xb7], [...'10H2O'].map((c) => c.charCodeAt(0))));
    expect(decodeLibraryText(bytes)).toBe('Name: Natron Na2CO3·10H2O');
  });
  it('keeps UTF-8 text as UTF-8', () => {
    expect(decodeLibraryText(new TextEncoder().encode('Name: Na2CO3·10H2O µm'))).toBe('Name: Na2CO3·10H2O µm');
  });
});

describe('CX-096 ENVI FWHM without wavelength units', () => {
  const hd = (units, wavelength, fwhm) => ({ bands: wavelength.length, bandNames: [], wavelength, fwhm, bbl: [], wavelengthUnits: units });
  it('takes the FWHM in the unit of the centre wavelengths (AVIRIS classic: nm, no units line)', () => {
    const b = enviBands(hd('', [365.9, 2496.2], [9.85, 9.9]));
    expect(b.map((x) => +x.cw.toFixed(4))).toEqual([0.3659, 2.4962]);
    expect(b.map((x) => +x.fwhm.toFixed(5))).toEqual([0.00985, 0.0099]);
  });
  it('keeps micrometres and declared units', () => {
    expect(enviBands(hd('', [0.4, 2.5], [0.01, 0.01])).map((x) => x.fwhm)).toEqual([0.01, 0.01]);
    expect(enviBands(hd('Nanometers', [400, 2500], [10, 10])).map((x) => x.fwhm)).toEqual([0.01, 0.01]);
  });
});

describe('IMP-26 library ranking', () => {
  const wl = Array.from({ length: 201 }, (_, i) => 0.4 + i * 0.01);
  const ramp = wl.map((x) => x);
  const flat = wl.map(() => 0.5);
  it('resamples like gw-spectral (Gaussian SRF, NaN outside the spectrum)', () => {
    const r = resampleSpectrum(wl, ramp, [1.0, 1.5, 3.0], [0.05, 0.05, 0.05]);
    expect(r[0]).toBeCloseTo(1.0, 6);
    expect(r[1]).toBeCloseTo(1.5, 6);
    expect(Number.isNaN(r[2])).toBe(true);
  });
  it('ranks reflectance spectra by spectral angle and leaves transmittance out', () => {
    const centres = [0.5, 0.8, 1.1, 1.4, 1.7, 2.0];
    const target = centres.map((x) => 2 * x); // same shape as the ramp, other scale
    const lib = [
      { name: 'flat', wl, values: flat, quantity: 'reflectance' },
      { name: 'ramp', wl, values: ramp, quantity: 'reflectance' },
      { name: 'ramp T', wl, values: ramp, quantity: 'transmittance' },
      { name: 'TIR only', wl: [8, 9, 10], values: [0.1, 0.2, 0.3], quantity: 'reflectance' },
    ];
    const r = rankLibrary(target, centres, [], lib);
    expect(r.map((x) => x.spectrum.name)).toEqual(['ramp', 'flat']);
    expect(r[0].angle).toBeCloseTo(0, 6);
    expect(rankLibrary(target, centres, [], lib, { quantities: ['transmittance'] }).map((x) => x.spectrum.name)).toEqual(['ramp T']);
    expect(Number.isNaN(spectralAngle([1, 2], [1, 2]))).toBe(true);
  });
});
