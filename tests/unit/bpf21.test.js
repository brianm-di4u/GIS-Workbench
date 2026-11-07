// REQ-FMT-47, REQ-FMT-48: BPF coordinate types (UTM, TCR/ECEF, ENU, Cartesian) on the FX-21 set, and the
// BPF v3 writer read back by the reader (none and zlib, every interleave). PDAL reads the written files
// back in tests/e2e/21-sar.spec.js and the campaign's c53.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseBpf, writeBpf, ecefToGeodeticJs, geodeticToEcefJs } from '../../app/src/formats/points-io.js';
import { generate } from '../../build/fixtures/fx21/sar.mjs';

const DIR = resolve('fixtures/fx21/sar');
if (!existsSync(join(DIR, 'bpf-utm-none.bpf'))) await generate(DIR);
const truth = JSON.parse(readFileSync(join(DIR, 'sar_truth.json'), 'utf8')).bpf;
const file = (n) => new File([readFileSync(join(DIR, n))], n);

describe('BPF coordinate types (FX-21)', () => {
  it('ECEF ↔ geodetic closed forms agree to well under a millimetre', () => {
    for (const [lat, lon, h] of [[36.1, -115.2, 610], [-33.9, 151.2, -20], [89.9, 10, 1000], [0, 180, 0]]) {
      const g = ecefToGeodeticJs(...geodeticToEcefJs(lat, lon, h));
      expect(g[0]).toBeCloseTo(lat, 9);
      expect(((g[1] - lon + 540) % 360) - 180).toBeCloseTo(0, 9);
      expect(g[2]).toBeCloseTo(h, 4);
    }
  });

  it('reads UTM, TCR (to WGS 84) and the local frames, none and zlib, every interleave', async () => {
    const utm = await parseBpf(file('bpf-utm-none.bpf'));
    expect(utm.n).toBe(truth.n);
    expect(utm.epsg).toBe(32611);
    expect(utm.x[0]).toBeCloseTo(truth.utmFirst[0], 2);
    for (const n of ['bpf-utm-zlib.bpf', 'bpf-utm-zlib-point.bpf', 'bpf-utm-zlib-byte.bpf']) {
      const b = await parseBpf(file(n));
      expect([...b.x], n).toEqual([...utm.x]);
      expect([...b.dims.Intensity], n).toEqual([...utm.dims.Intensity]);
    }
    for (const c of ['none', 'zlib']) {
      const t = await parseBpf(file(`bpf-tcr-${c}.bpf`));
      expect(t.frame).toBe('ecef');
      expect(t.epsg).toBe(4326);
      // f32 + offset storage of ECEF metres: about a centimetre.
      for (let k = 0; k < 5; k++) {
        expect(Math.abs(t.y[k] - truth.points[k].lat) * 111e3).toBeLessThan(0.05);
        expect(Math.abs(t.x[k] - truth.points[k].lon) * 90e3).toBeLessThan(0.05);
        expect(Math.abs(t.z[k] - truth.points[k].h)).toBeLessThan(0.05);
      }
      for (const fr of ['enu', 'cart']) {
        const b = await parseBpf(file(`bpf-${fr}-${c}.bpf`));
        expect(b.local).toBe(true);
        expect(b.epsg).toBe(null);
        expect(b.frame).toBe(fr === 'enu' ? 'enu' : 'cartesian');
      }
    }
    const e = await parseBpf(file('bpf-enu-none.bpf'));
    expect(e.x[0]).toBeCloseTo(truth.enuFirst[0], 2);
  });

  it('refuses an undefined coordinate type and an unknown TCR datum by name', async () => {
    const b = new Uint8Array(readFileSync(join(DIR, 'bpf-utm-none.bpf')));
    new DataView(b.buffer).setInt32(20, 7, true);
    await expect(parseBpf(new File([b], 'x.bpf'))).rejects.toThrow(/coordinate type 7 is not defined/);
    const t = new Uint8Array(readFileSync(join(DIR, 'bpf-tcr-none.bpf')));
    new DataView(t.buffer).setInt32(24, 15, true);
    await expect(parseBpf(new File([t], 'y.bpf'))).rejects.toThrow(/TCR \(ECEF\) coordinate id 15/);
  });
});

describe('BPF writer', () => {
  const cloudOf = (src) => {
    const n = src.n;
    const c = { n, intensity: new Uint16Array(n), ret: new Uint8Array(n), class: new Uint8Array(n), scan: new Int16Array(n), user: new Uint8Array(n), source: new Uint16Array(n), rgb: null };
    for (let k = 0; k < n; k++) {
      c.intensity[k] = src.dims.Intensity[k];
      c.class[k] = src.dims.Classification[k];
      c.ret[k] = src.dims.ReturnNumber[k] | (src.dims.NumberOfReturns[k] << 4);
      c.scan[k] = (k % 41) - 20;
      c.source[k] = 7;
      c.user[k] = k % 256;
    }
    return c;
  };
  it('round-trips every coordinate type, compression and interleave', async () => {
    const src = await parseBpf(file('bpf-utm-none.bpf'));
    const c = cloudOf(src);
    for (const coordType of [0, 1, 2, 3])
      for (const compression of ['none', 'zlib', 'fastlz'])
        for (const interleave of [0, 1, 2]) {
          const bytes = await writeBpf(c, { x: src.x, y: src.y, z: src.z, coordType, coordId: coordType === 1 ? 11 : coordType === 2 ? 1 : 0, compression, interleave, time: src.dims.GpsTime });
          const tag = `${coordType}/${compression}/${interleave}`;
          if (compression === 'zlib') expect(bytes[14], tag).toBe(3);
          if (compression === 'fastlz') expect(bytes[14], tag).toBe(2);
          if (coordType === 2) continue; // UTM numbers labelled TCR are not ECEF; the type itself is checked below
          const b = await parseBpf(new File([bytes], 'w.bpf'));
          expect(b.n, tag).toBe(src.n);
          for (let k = 0; k < src.n; k += 37) {
            expect(Math.abs(b.x[k] - src.x[k]), tag).toBeLessThan(0.01);
            expect(Math.abs(b.z[k] - src.z[k]), tag).toBeLessThan(0.01);
            expect(b.dims.Intensity[k]).toBe(c.intensity[k]);
            expect(b.dims.ScanAngleRank[k]).toBe(c.scan[k]);
            expect(b.dims.UserData[k]).toBe(c.user[k]);
            expect(b.dims.PointSourceId[k]).toBe(7);
            expect(Math.abs(b.dims.GpsTime[k] - src.dims.GpsTime[k])).toBeLessThan(1e-3);
          }
        }
  });
  it('writes ECEF that reads back as the same WGS 84 points', async () => {
    const t = await parseBpf(file('bpf-tcr-none.bpf'));
    const e = Array.from({ length: t.n }, (_, k) => geodeticToEcefJs(t.y[k], t.x[k], t.z[k]));
    const bytes = await writeBpf(cloudOf(t), { x: e.map((v) => v[0]), y: e.map((v) => v[1]), z: e.map((v) => v[2]), coordType: 2, coordId: 1, compression: 'zlib' });
    const b = await parseBpf(new File([bytes], 'e.bpf'));
    for (let k = 0; k < t.n; k += 13) {
      expect(Math.abs(b.y[k] - t.y[k]) * 111e3).toBeLessThan(0.02);
      expect(Math.abs(b.z[k] - t.z[k])).toBeLessThan(0.02);
    }
  });
});
