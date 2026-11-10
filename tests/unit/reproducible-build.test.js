import { createHash } from 'node:crypto';
import { strToU8 } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { packZip } from '../../build/packs.mjs';

const h = (b) => createHash('sha256').update(b).digest('hex');
const files = () => ({ 'pack.json': strToU8('{"name":"t"}'), 'a.js': [strToU8('x'.repeat(5000)), { level: 6 }], 'm.onnx': [new Uint8Array(64), { level: 0 }] });

describe('reproducible packs', () => {
  const tz = process.env.TZ;
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it('writes the same bytes on every build, later and in another time zone', async () => {
    const first = h(packZip(files()));
    await new Promise((r) => setTimeout(r, 2100)); // ZIP time has 2-second steps
    expect(h(packZip(files()))).toBe(first);
    for (const zone of ['Pacific/Auckland', 'America/Los_Angeles', 'UTC']) {
      process.env.TZ = zone;
      expect(h(packZip(files()))).toBe(first);
    }
  });

  it('still changes when the content does', () => {
    expect(h(packZip({ ...files(), 'a.js': strToU8('y') }))).not.toBe(h(packZip(files())));
  });
});

describe('reproducible HTML blocks (#34)', () => {
  it('gzip headers say "unknown OS", not the build machine', async () => {
    const { gunzipSync } = await import('node:zlib');
    const { gzipStable } = await import('../../build/repro.mjs');
    const data = strToU8('x'.repeat(5000));
    const z = gzipStable(data);
    expect(z[9]).toBe(255);
    expect([...z.subarray(4, 8)]).toEqual([0, 0, 0, 0]); // no time stamp either
    expect(h(gunzipSync(z))).toBe(h(data));
  });

});
