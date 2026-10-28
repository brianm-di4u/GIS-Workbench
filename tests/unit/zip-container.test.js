// TE-060 TE-067 IMP-21 REQ-FMT-20: imagery in ZIP packages — central directory, stored and deflated entries,
// ZIPs inside ZIPs, damaged archives; TE-061: MrSID recognised by its header.
import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { listZip, entryFile, expandZip, isImageryZip, defaultPick } from '../../app/src/formats/zip-container.js';
import { mrsidHeader, mrsidRefusal } from '../../app/src/workers/decode/mrsid-header.js';

const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const asFile = (u8, name) => new File([u8], name);
const tif = bytes(5000, 7);
const tfw = new TextEncoder().encode('0.5\n0\n0\n-0.5\n100\n200\n');

describe('ZIP packages (TE-060)', () => {
  it('lists entries and reads stored and deflated ones byte-exact', async () => {
    const z = asFile(zipSync({ 'pkg/IMG_R1C1.TIF': [tif, { level: 0 }], 'pkg/IMG_R1C1.TFW': [tfw, { level: 6 }], 'pkg/empty/': new Uint8Array(0) }), 'pkg.zip');
    const es = await listZip(z);
    expect(es.map((e) => e.path).sort()).toEqual(['pkg/IMG_R1C1.TFW', 'pkg/IMG_R1C1.TIF']);
    for (const e of es) {
      const f = await entryFile(z, e);
      expect(f.name).toBe(e.name);
      expect(new Uint8Array(await f.arrayBuffer())).toEqual(e.name.endsWith('TIF') ? tif : tfw);
    }
    expect(es.find((e) => e.name.endsWith('TFW')).method).toBe(8);
  });

  it('expands imagery ZIPs inside a ZIP and keeps shapefile ZIPs whole', async () => {
    const reef = zipSync({ 'Reef_R1C1.tif': [tif, { level: 0 }], 'Reef_BROWSE.tif': bytes(100), 'Reef_TILE_SHAPE.zip': zipSync({ 'a.shp': bytes(50), 'a.dbf': bytes(20) }) }, { level: 0 });
    const outer = asFile(zipSync({ 'Islands/Reef 20150101.zip': [reef, { level: 0 }], 'Islands/Other 20150202.zip': [reef, { level: 0 }] }), 'Islands.zip');
    expect(await isImageryZip(outer)).toBe(true);
    const es = await expandZip(outer);
    expect(es.map((e) => e.zipPath)).toContain('Islands.zip/Islands/Reef 20150101.zip/Reef_R1C1.tif');
    const shp = es.find((e) => e.name === 'Reef_TILE_SHAPE.zip');
    expect(await isImageryZip(await shp.open())).toBe(false);
    const f = await es.find((e) => e.name === 'Reef_R1C1.tif').open();
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(tif);
    // Default pick: the imagery and the overlays, not the browse quick look.
    const pick = defaultPick(es).map((e) => e.name);
    expect(pick).toContain('Reef_R1C1.tif');
    expect(pick).toContain('Reef_TILE_SHAPE.zip');
    expect(pick).not.toContain('Reef_BROWSE.tif');
  });

  it('TE-067 classifies a delivery of deflated ZIPs and expands them only within the budget', async () => {
    const reef = (n) => zipSync({ [`R${n}_R1C1.tif`]: [bytes(4000, n), { level: 0 }] });
    const outer = asFile(zipSync({ 'A.zip': [reef(1), { level: 6 }], 'B.zip': [reef(2), { level: 6 }], 'C.zip': [reef(3), { level: 6 }] }), 'D.zip');
    expect(await isImageryZip(outer)).toBe(true);
    const size = (await listZip(outer))[0].size;
    const es = await expandZip(outer, 0, 'D.zip', { bytes: size * 2 + 10 });
    expect(es.filter((e) => e.nested).map((e) => e.name)).toEqual(['C.zip']);
    expect(defaultPick(es).map((e) => e.name).sort()).toEqual(['R1_R1C1.tif', 'R2_R1C1.tif']);
    const inner = await es.find((e) => e.nested).open();
    expect(await isImageryZip(inner)).toBe(true);
  });

  it('starts a large delivery with its first package selected', () => {
    const es = Array.from({ length: 40 }, (_, i) => ({ name: `T${i}.tif`, path: `T${i}.tif`, group: `g${i % 4}` }));
    expect(new Set(defaultPick(es).map((e) => e.group))).toEqual(new Set(['g0']));
  });

  it('a ZIP of vectors stays on the vector route', async () => {
    expect(await isImageryZip(asFile(zipSync({ 'roads.shp': bytes(10), 'roads.dbf': bytes(10) }), 'roads.zip'))).toBe(false);
  });

  it('damaged archives fail by name', async () => {
    const good = zipSync({ 'a.tif': [tif, { level: 0 }] });
    await expect(listZip(asFile(good.slice(0, good.length - 30), 'cut.zip'))).rejects.toThrow(/not a ZIP|truncated|damaged/);
    await expect(listZip(asFile(bytes(4000), 'noise.zip'))).rejects.toThrow(/not a ZIP archive/);
    const z = asFile(zipSync({ 'a.tif': [tif, { level: 6 }] }), 'a.zip');
    const [e] = await listZip(z);
    await expect(entryFile(z, { ...e, method: 12 })).rejects.toThrow(/compression method 12/);
    await expect(entryFile(z, { ...e, encrypted: true })).rejects.toThrow(/encrypted/);
  });
});

describe('MrSID header (TE-061)', () => {
  // First 41 bytes of the field sample Stl_City.sid (MG3, GeoExpress 9.1).
  const hex = '6d73696403001a710103000000000000002800000000000000060001800000' + '02e0000b0003200040' + '08';
  const head = Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));
  it('reads size, bands and depth', () => {
    expect(mrsidHeader(head)).toEqual({ version: 3, generation: 'MG3', width: 98304, height: 188416, bands: 3, bits: 8 });
  });
  it('names the format and the image in the refusal', () => {
    expect(mrsidRefusal(head)).toMatch(/^MrSID \(MG3; 98,304 × 188,416 px, 3 bands, 8-bit\).*Cloud-Optimized GeoTIFF/);
    expect(mrsidHeader(new TextEncoder().encode('not a sid'))).toBeNull();
  });
});
