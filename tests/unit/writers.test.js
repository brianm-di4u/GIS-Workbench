// Product writers (REQ-FMT-05/06, REQ-PRD-03/10): GeoTIFF round trip through geotiff.js
// (tiling, Deflate, predictors 2 and 3, overviews, GeoKeys, geotransform, RPC, nodata), NITF
// field layout (header length, RPC00B and ICHIPB sizes, IGEOLO) and PDF cross-reference offsets.
import { describe, it, expect } from 'vitest';
import { fromArrayBuffer } from 'geotiff';
import { writeGeoTiff, halve } from '../../app/src/formats/geotiff-writer.js';
import { writeNitf, rpc00b, ichipb, dms, securityGroup } from '../../app/src/formats/nitf-writer.js';
import { writePdf } from '../../app/src/formats/pdf-writer.js';
import { resolveTokens, acqTime } from '../../app/src/products/tokens.js';
import { parsePortion, splitPortion, parseDraft } from '../../app/src/products/report.js';

const tag = async (fd, id) => (typeof fd.loadValue === 'function' ? (fd.hasTag(id) ? fd.loadValue(id) : undefined) : fd[id]);
const open = async (u8) => fromArrayBuffer(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));

describe('GeoTIFF writer', () => {
  it('round-trips u16 with predictor 2, overviews, EPSG and a geotransform', async () => {
    const W = 700;
    const H = 530;
    const data = new Uint16Array(W * H);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7919) % 65521;
    const u8 = await writeGeoTiff({ width: W, height: H, bands: 1, type: 'u16', data }, { epsg: 32633, geotransform: [500000, 0.5, 0, 4200000, 0, -0.5], nodata: 0 });
    const t = await open(u8);
    expect(await t.getImageCount()).toBe(3); // 700 → 350 → 175
    const im = await t.getImage();
    expect([im.getWidth(), im.getHeight()]).toEqual([W, H]);
    expect(im.getTileWidth()).toBe(256);
    const [r] = await im.readRasters();
    expect(Array.from(r.slice(0, 1000))).toEqual(Array.from(data.slice(0, 1000)));
    expect(r[W * H - 1]).toBe(data[W * H - 1]);
    expect(im.getGeoKeys().ProjectedCSTypeGeoKey).toBe(32633);
    expect(im.getOrigin()).toEqual([500000, 4200000, 0]);
    expect(im.getResolution()[0]).toBe(0.5);
    expect(im.getGDALNoData()).toBe(0);
    const ov = await t.getImage(2);
    expect([ov.getWidth(), ov.getHeight()]).toEqual([175, 133]);
  });

  it('round-trips f32 with predictor 3, three bands and an RPC tag', async () => {
    const W = 300;
    const H = 260;
    const data = new Float32Array(W * H * 3);
    for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.001) * 1000 + (i % 3);
    const rpc = Array.from({ length: 92 }, (_, i) => i * 0.25 - 3);
    const u8 = await writeGeoTiff({ width: W, height: H, bands: 3, type: 'f32', data }, { rpc, overviews: false });
    const t = await open(u8);
    const im = await t.getImage();
    expect(await tag(im.fileDirectory, 'Predictor')).toBe(3);
    const rs = await im.readRasters();
    for (let b = 0; b < 3; b++) for (const i of [0, 777, W * H - 1]) expect(rs[b][i]).toBe(data[i * 3 + b]);
    expect(Array.from(await tag(im.fileDirectory, 50844))).toEqual(rpc);
  });

  it('halves with nodata excluded', () => {
    const img = { width: 3, height: 2, bands: 1, type: 'u8', data: Uint8Array.from([10, 0, 30, 20, 0, 0]) };
    const r = halve(img, 'mean', 0);
    expect([r.width, r.height]).toEqual([2, 1]);
    expect(Array.from(r.data)).toEqual([15, 30]);
  });
});

describe('NITF writer', () => {
  it('writes the fixed lengths and fields', () => {
    expect(securityGroup({ level: 'U' })).toHaveLength(167);
    const rec = [12.5, 3.25, 2048, 1500, 38.1234, -77.5678, 120, 2048, 1500, 0.05, 0.06, 500, ...Array.from({ length: 80 }, (_, i) => (i % 7 ? (i - 40) * 1e-5 : 1.234567e-12))];
    const r = rpc00b(rec);
    expect(r).toHaveLength(1041);
    expect(r.slice(0, 15)).toBe('10012.500003.25');
    expect(r.slice(81, 93)).toBe('+0.000000E+0'); // tiny coefficient
    const c = ichipb({ x0: 100, y0: 200, w: 50, h: 40, step: 2, fullW: 4000, fullH: 3000 });
    expect(c).toHaveLength(224);
    expect(c.slice(208, 216)).toBe('00003000');
    expect(c.slice(112, 124)).toBe('00000200.500'); // FI_ROW_11
    expect(dms(-33.5, 151.25)).toBe('333000S1511500E');
  });

  it('lays out the file: FL, HL, LISH, LI and big-endian samples', () => {
    const planes = [Uint16Array.from([1, 2, 258, 65535, 7, 8])];
    const u8 = writeNitf({ width: 3, height: 2, bands: 1, type: 'u16', planes }, { marking: { level: 'U' }, corners: [[1, 2], [1, 3], [0, 3], [0, 2]], abpp: 11 });
    const s = new TextDecoder('latin1').decode(u8);
    expect(s.slice(0, 9)).toBe('NITF02.10');
    expect(Number(s.slice(342, 354))).toBe(u8.length); // FL
    expect(Number(s.slice(354, 360))).toBe(404); // HL
    const lish = Number(s.slice(363, 369));
    const li = Number(s.slice(369, 379));
    expect(404 + lish + li).toBe(u8.length);
    expect(li).toBe(12);
    const sub = s.slice(404, 404 + lish);
    expect(sub.slice(0, 2)).toBe('IM');
    const data = u8.subarray(404 + lish);
    expect([data[4], data[5]]).toEqual([1, 2]); // 258 big-endian
    expect(sub).toContain('G010000N0020000E');
  });
});

describe('PDF writer', () => {
  it('writes valid cross-reference offsets', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const u8 = writePdf([{ widthMm: 210, heightMm: 297, strips: [{ jpeg, width: 10, height: 10, yMm: 0, hMm: 148.5 }, { jpeg, width: 10, height: 10, yMm: 148.5, hMm: 148.5 }] }], { title: 'A (test)' });
    const s = new TextDecoder('latin1').decode(u8);
    const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
    expect(s.slice(xref, xref + 4)).toBe('xref');
    const entries = s.slice(xref).split('\n').slice(3).filter((l) => / n $/.test(l));
    entries.forEach((e, i) => expect(s.slice(Number(e.slice(0, 10)), Number(e.slice(0, 10)) + 8)).toBe(`${i + 1} 0 obj`.padEnd(8, '\n').slice(0, 8)));
    expect(s).toContain('/Title (A \\(test\\))');
  });
});

describe('autolabels and portions', () => {
  it('resolves tokens with substrings and fallbacks, never blank (AT-16.3)', () => {
    const v = { IMAGE_ID: '18DEC15WV031000', ACQ_DATE: '', USER: null };
    expect(resolveTokens('{IMAGE_ID[0:7]}|{ACQ_DATE|unknown}|{USER}|{NOPE|x}', v)).toBe('18DEC15|unknown|[n/a]|x');
    expect(resolveTokens('{IMAGE_ID[99:100]|none}', v)).toBe('none');
    expect(acqTime('20151218140455')).toBe('2015-12-18 14:04:55Z');
    expect(acqTime('2015:12:18 14:04:55')).toBe('2015-12-18 14:04:55Z');
  });
  it('parses portion marks and raises unmarked AI paragraphs', () => {
    expect(parsePortion('(C)')).toMatchObject({ level: 'C' });
    expect(parsePortion('(S//NF)')).toMatchObject({ level: 'S', codewords: 'NF' });
    expect(splitPortion('(U) text')).toEqual({ mark: '(U)', text: 'text' });
    const d = parseDraft('BLUF:\n(U) a\n\nb\n\nCOMMENTS:\n(S) c', { level: 'C' });
    expect(d.bluf.split('\n\n')).toEqual(['(C) a', '(C) b']);
    expect(d.comments).toBe('(S) c');
    expect(d.fixed).toBe(2);
  });
});

describe('NITF writer: more than 9 bands', () => {
  it('writes NBANDS 0 with XBANDS (hyperspectral chips, TE 2.0.4 cross)', () => {
    const nb = 12;
    const planes = Array.from({ length: nb }, (_, b) => Uint16Array.from({ length: 6 }, (_, k) => b * 10 + k));
    const u8 = writeNitf({ width: 3, height: 2, bands: nb, type: 'u16', planes }, { marking: { level: 'U' } });
    const text = new TextDecoder('latin1').decode(u8);
    expect(text).toContain('NC000012');
    // Band-interleaved by block: the last band's first sample follows 11 bands of 6 samples.
    const dataStart = u8.length - nb * 6 * 2;
    expect(new DataView(u8.buffer, u8.byteOffset).getUint16(dataStart + 11 * 12, false)).toBe(110);
  });
});
