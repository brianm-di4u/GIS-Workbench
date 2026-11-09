// REQ-GAP-47 MIE4NITF: the TRE readers (binary DT fields), exact frame times, camera placement, the
// collection model (CAMSDA mosaics, MIMCSA layers, MTIMFA mappings, TMINTA), the chip round trip
// and, through the real parse/j2k WASM bundles, the worker's lazy frame sequences on the synthetic
// fixtures (fixtures/fx24/motion, build/fixtures/fx24-motion.mjs). No independent MIE4NITF sample
// exists (OD-05, O-12): the oracle is the writer plus the TRE layouts of STDI-0002-1 Appendix AF.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, openSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseStamp, stampOf, isoNs, msOf, parseMTIMSA, frameTimes, encodeMTIMSA, parseCAMSDA, encodeCAMSDA, parseMIMCSA, encodeMIMCSA, parseMTIMFA, encodeMTIMFA, parseTMINTA, encodeTMINTA, placeCameras, mieCollection, frameAt,
} from '../../app/src/formats/mie4nitf.js';

const bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const T0 = parseStamp('20251025120000.000000000').ns;

describe('MIE4NITF timestamps', () => {
  it('parses to exact nanoseconds and writes back the same 24 bytes', () => {
    const s = parseStamp('20260915120000.123456789');
    expect(s.ns).toBe(1789473600123456789n);
    expect(s.digits).toBe(9);
    expect(stampOf(s.ns)).toBe('20260915120000.123456789');
    expect(isoNs(s.ns)).toBe('2026-09-15T12:00:00.123456789Z');
    expect(msOf(s.ns)).toBeCloseTo(1789473600123.457, 2);
  });
  it('reads unknown precision (trailing dashes) and refuses invalid dates', () => {
    expect(parseStamp('20260915120000.12-------').ns).toBe(1789473600120000000n);
    expect(parseStamp('20260915120000.---------').digits).toBe(0);
    expect(parseStamp('20260230120000.000000000')).toBeNull();
    expect(parseStamp('2026091512000')).toBeNull();
  });
});

describe('MTIMSA', () => {
  const base = { segment: 1, layer: 'EO', set: 1, camera: '11111111-1111-4111-8111-111111111111', interval: 7, block: 1, rate: 2, refFrame: 41, base: T0 };
  it('reads every field, the binary DT_MULTIPLIER/DT_SIZE/NUMBER_FRAMES/NUMBER_DT and each DT', () => {
    const b = bytes(encodeMTIMSA({ ...base, mult: (1n << 53n) + 1n, dts: [0n, 10n, 0x0102030405n], frames: 3 }));
    expect(b.length).toBe(152 + 3 * 5);
    const m = parseMTIMSA(b);
    expect(m).toMatchObject({ segment: 1, layer: 'EO', set: 1, camera: base.camera, interval: 7, block: 1, rate: 2, refFrame: 41, dtSize: 5, frames: 3, numberDt: 3 });
    expect(m.mult).toBe((1n << 53n) + 1n);
    expect(m.dts).toEqual([0n, 10n, 0x0102030405n]);
    expect(m.base.ns).toBe(T0);
  });
  it('one DT per frame: T(n) = base + Σ DT_i × DT_MULTIPLIER (cumulative, DT_1 offsets the first frame)', () => {
    const m = parseMTIMSA(bytes(encodeMTIMSA({ ...base, mult: 1_000_000n, dts: [0n, 400n, 600n, 500n], frames: 4 })));
    expect(frameTimes(m)).toEqual({ ns: [T0, T0 + 400_000_000n, T0 + 1_000_000_000n, T0 + 1_500_000_000n], note: null });
  });
  it('one DT for every frame: T(n) = base + n × DT × DT_MULTIPLIER', () => {
    const m = parseMTIMSA(bytes(encodeMTIMSA({ ...base, mult: 1000n, dts: [500_000n], frames: 3 })));
    expect(frameTimes(m).ns).toEqual([T0 + 500_000_000n, T0 + 1_000_000_000n, T0 + 1_500_000_000n]);
  });
  it('no DT: one frame at BASE_TIMESTAMP; several frames without DT spread at the nominal rate with a note', () => {
    expect(frameTimes(parseMTIMSA(bytes(encodeMTIMSA({ ...base, dts: [], frames: 1 }))))).toEqual({ ns: [T0], note: null });
    const r = frameTimes(parseMTIMSA(bytes(encodeMTIMSA({ ...base, rate: 4, dts: [], frames: 3 }))));
    expect(r.ns).toEqual([T0, T0 + 250_000_000n, T0 + 500_000_000n]);
    expect(r.note).toMatch(/no DT/);
  });
  it('the 2.3 fixtures (legacy rate text, NUMBER_DT 0) keep their times', () => {
    const f = readFileSync(resolve('fixtures/formats/mie4nitf.ntf'));
    const s = f.toString('latin1');
    const at = s.indexOf('MTIMSA');
    const cel = Number(s.slice(at + 6, at + 11));
    const m = parseMTIMSA(new Uint8Array(f.subarray(at + 11, at + 11 + cel)));
    expect(m.rate).toBe(2);
    expect(frameTimes(m).note).toBeNull();
  });
  it('a truncated DT list is an error, not a misread', () => {
    const b = bytes(encodeMTIMSA({ ...base, dts: [1n, 2n, 3n], frames: 3 }));
    expect(() => parseMTIMSA(b.subarray(0, b.length - 1))).toThrow(/overrun/);
  });
});

describe('CAMSDA, MIMCSA, MTIMFA, TMINTA', () => {
  const cams = [
    { id: 'A', desc: 'a', layer: 'EO', idlvl: 1, ialvl: 0, iloc: [0, 0], nrows: 64, ncols: 96 },
    { id: 'B', desc: 'b', layer: 'EO', idlvl: 2, ialvl: 1, iloc: [0, 96], nrows: 64, ncols: 96 },
    { id: 'C', desc: 'c', layer: 'EO', idlvl: 3, ialvl: 2, iloc: [64, -96], nrows: 64, ncols: 96 },
  ];
  it('round-trip the encoders (CAMSDA 9 + 3 per set + 184 per camera; MIMCSA 121)', () => {
    const c = bytes(encodeCAMSDA([{ cameras: cams }], { total: 4, first: 2 }));
    expect(c.length).toBe(9 + 3 + 184 * 3);
    const p = parseCAMSDA(c);
    expect(p.total).toBe(4);
    expect(p.sets[0].index).toBe(2);
    expect(p.sets[0].cameras[2]).toEqual(cams[2]);
    const l = parseMIMCSA(bytes(encodeMIMCSA({ layer: 'EO', rate: 29.97, minRate: 25, maxRate: 30, decoder: 'C8', profile: 'ISO/IEC 15444-1', level: 'class2' })));
    expect(l).toEqual({ layer: 'EO', rate: 29.97, minRate: 25, maxRate: 30, rset: 0, decoder: 'C8', profile: 'ISO/IEC 15444-1', level: 'class2' });
    const f = parseMTIMFA(bytes(encodeMTIMFA({ layer: 'EO', set: 1, interval: 7, cameras: [{ id: 'A', blocks: [{ start: T0, end: T0 + 1n, segment: 3 }, { start: T0 + 2n, end: T0 + 3n, segment: null }] }] })));
    expect(f.cameras[0].blocks.map((b) => [b.start.ns, b.end.ns, b.segment])).toEqual([[T0, T0 + 1n, 3], [T0 + 2n, T0 + 3n, null]]);
    expect(parseTMINTA(bytes(encodeTMINTA([{ index: 1, start: T0, end: T0 + 5n }])))[0]).toMatchObject({ index: 1 });
  });
  it('places cameras through their attachment chain, the mosaic origin at the top-left camera', () => {
    expect(placeCameras(cams).at).toEqual([{ x: 0, y: 0 }, { x: 96, y: 0 }, { x: 0, y: 64 }]);
    expect(placeCameras([{ ...cams[0], ialvl: 0, iloc: [10, 20] }, { ...cams[1], ialvl: 0, iloc: [10, 116] }]).at).toEqual([{ x: 0, y: 0 }, { x: 96, y: 0 }]);
    expect(placeCameras([{ ...cams[0], ialvl: 9 }]).reason).toMatch(/missing display level 9/);
  });
});

describe('the collection', () => {
  const seg = (index, m, extra = {}) => ({ index, mtimsa: bytes(encodeMTIMSA({ segment: index + 1, ...m })), width: 96, height: 64, bands: 1, sampleType: 'u8', ic: 'NC', imode: 'B', ...extra });
  const cam = (id) => ({ id, desc: '', layer: 'EO', idlvl: id === 'A' ? 1 : 2, ialvl: id === 'A' ? 0 : 1, iloc: id === 'A' ? [0, 0] : [0, 96], nrows: 64, ncols: 96 });
  it('a camera set mosaics its cameras; frames align by REFERENCE_FRAME_NUM', () => {
    const fileTres = [{ tag: 'CAMSDA', bytes: bytes(encodeCAMSDA([{ cameras: [cam('A'), cam('B')] }])) }, { tag: 'MIMCSA', bytes: bytes(encodeMIMCSA({ layer: 'EO', rate: 2, decoder: 'NC' })) }];
    const segments = [seg(0, { layer: 'EO', camera: 'B', refFrame: 2, base: T0 + 500_000_001n, dts: [], frames: 1 }), seg(1, { layer: 'EO', camera: 'A', refFrame: 1, base: T0, dts: [], frames: 1 }), seg(2, { layer: 'EO', camera: 'A', refFrame: 2, base: T0 + 500_000_000n, dts: [], frames: 1 }), seg(3, { layer: 'EO', camera: 'B', refFrame: 1, base: T0 + 1n, dts: [], frames: 1 })];
    const c = mieCollection({ fileTres, segments });
    expect(c.warnings).toEqual([]);
    expect(c.sequences).toHaveLength(1);
    const s = c.sequences[0];
    expect([s.width, s.height, s.rate, s.decoder]).toEqual([192, 64, 2, 'NC']);
    expect(s.frames.map((f) => [f.ns - T0, f.parts.map((p) => p.seg)])).toEqual([[0n, [1, 3]], [500_000_000n, [2, 0]]]);
  });
  it('without frame numbers, cameras align by time (the latest frame within half a period)', () => {
    const fileTres = [{ tag: 'CAMSDA', bytes: bytes(encodeCAMSDA([{ cameras: [cam('A'), cam('B')] }])) }];
    const segments = [seg(0, { layer: 'EO', camera: 'A', rate: 2, base: T0, mult: 1_000_000n, dts: [0n, 500n, 500n], frames: 3 }), seg(1, { layer: 'EO', camera: 'B', rate: 2, base: T0 + 600_000_000n, dts: [], frames: 1 })];
    const s = mieCollection({ fileTres, segments }).sequences[0];
    expect(s.frames.map((f) => f.parts.map((p) => `${p.seg}:${p.k}`))).toEqual([['0:0'], ['0:1', '1:0'], ['0:2', '1:0']]);
  });
  it('without CAMSDA each camera is its own sequence; MTIMFA and MIMCSA mismatches are reported', () => {
    const fileTres = [
      { tag: 'MIMCSA', bytes: bytes(encodeMIMCSA({ layer: 'EO', rate: 2, decoder: 'C8' })) },
      { tag: 'MTIMFA', bytes: bytes(encodeMTIMFA({ layer: 'EO', set: 1, interval: 1, cameras: [{ id: 'A', blocks: [{ start: T0, end: T0 + 1n, segment: 2 }, { start: T0 + 5n, end: T0 + 9n, segment: null }] }] })) },
    ];
    const segments = [seg(0, { layer: 'EO', camera: 'A', base: T0, dts: [], frames: 1 }), seg(1, { layer: 'EO', camera: 'B', base: T0, dts: [], frames: 1 })];
    const c = mieCollection({ fileTres, segments });
    expect(c.sequences).toHaveLength(2);
    expect(c.warnings.join('\n')).toMatch(/no CAMSDA/);
    expect(c.warnings.join('\n')).toMatch(/MTIMFA maps camera A to image segment 2, whose MTIMSA names camera B/);
    expect(c.warnings.join('\n')).toMatch(/MIMCSA requires decoder C8/);
    expect(c.sequences.find((s) => s.cameras[0].id === 'A').gaps).toEqual([{ camera: 'A', interval: 1, start: T0 + 5n, end: T0 + 9n }]);
  });
  it('frameAt finds the frame shown at a time', () => {
    const fr = [{ ns: '10' }, { ns: '20' }, { ns: '30' }];
    expect([5, 10, 19, 20, 29, 31].map((t) => frameAt(fr, t))).toEqual([0, 0, 0, 1, 1, 2]);
  });
});

// ---- through the WASM bundles ----------------------------------------------------------------------

const wasmDir = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release');
  } catch {
    return null;
  }
})();
const haveWasm = wasmDir && existsSync(join(wasmDir, 'gw_bundle_parse.wasm')) && existsSync(join(wasmDir, 'gw_bundle_j2k.wasm'));
const FX = resolve('fixtures/fx24/motion');
const truth = existsSync(join(FX, 'fx24_motion_truth.json')) ? JSON.parse(readFileSync(join(FX, 'fx24_motion_truth.json'), 'utf8')) : null;

describe.skipIf(!haveWasm || !truth)('worker sequences (parse + j2k WASM)', async () => {
  const { Bundle } = await import('../../app/src/wasm/abi.js');
  const { openNitf } = await import('../../app/src/workers/decode/nitf.js');
  const { openMie, isMieImage, describeSequence, writeChip } = await import('../../app/src/workers/decode/mie.js');
  const { LRU } = await import('../../app/src/workers/decode/pyramid.js');
  const parse = haveWasm ? new Bundle(new WebAssembly.Module(readFileSync(join(wasmDir, 'gw_bundle_parse.wasm'))), 'parse') : null;
  const j2k = haveWasm ? new Bundle(new WebAssembly.Module(readFileSync(join(wasmDir, 'gw_bundle_j2k.wasm'))), 'j2k') : null;
  globalThis.self ??= globalThis;
  self.GW = { ...(self.GW ?? {}), ensure: async () => j2k };
  const open = async (path, name = path.split(/[\\/]/).pop()) => {
    const file = new File([readFileSync(path)], name);
    const r = await openNitf(file, parse, { defer: isMieImage });
    return { r, m: await openMie(file, r, parse, { tileCache: new LRU(64 << 20) }) };
  };

  it('mie_multicam.ntf: two sequences, no segment opened at open beyond frame 0, mosaic pixels per camera and frame', async () => {
    const { r, m } = await open(join(FX, 'mie_multicam.ntf'));
    expect(r.sources).toHaveLength(0);
    expect(r.images.every((i) => i.deferred)).toBe(true);
    expect(m.collection.warnings).toEqual([]);
    const [eo, ir] = m.sequences;
    expect(eo.info().sourcesOpened).toBe(3); // frame 0: one segment per camera
    expect(ir.info().sourcesOpened).toBe(1);
    const d = describeSequence(eo);
    const te = truth.multicam.sequences[0];
    expect([eo.width, eo.height, d.frames.length]).toEqual([te.width, te.height, te.frames]);
    expect(d.frames.map((f) => f.ns)).toEqual(te.times);
    expect(d.cameras.map((c) => [c.x, c.y])).toEqual(te.cameras);
    expect(d.gaps).toHaveLength(1);
    for (const f of [0, 3, 4, 7]) {
      const src = (await eo.pyramid(f)).src;
      const [v] = await src.readWindow(0, 0, eo.width, eo.height, [0]);
      for (const [cam, [cx, cy]] of te.cameras.entries()) for (const [x, y] of [[0, 0], [7, 3], [95, 63]]) expect(v[(cy + y) * eo.width + cx + x], `frame ${f} camera ${cam} (${x}, ${y})`).toBe((cam * 50 + f * 5 + ((x + y) % 5)) & 255);
      expect(v[te.gapPixel[1] * eo.width + te.gapPixel[0]]).toBe(0);
    }
    const di = describeSequence(ir);
    expect(di.frames.map((f) => f.ns)).toEqual(truth.multicam.sequences[1].times);
    for (const f of [0, 2, 4]) {
      const [v] = await (await ir.pyramid(f)).src.readWindow(10, 5, 1, 1, [0]);
      expect(v[0]).toBe(1000 + f * 100 + 10);
    }
  });

  it('mie_j2k.ntf: tiled JPEG 2000 frames decode only the tiles a window touches, at the level asked', async () => {
    const { m } = await open(join(FX, 'mie_j2k.ntf'));
    const s = m.sequences[0];
    expect(describeSequence(s).decoder).toBe('C8');
    for (const f of [0, 3]) {
      const src = (await s.pyramid(f)).src;
      const [w] = await src.readWindow(300, 90, 40, 40, [0]);
      for (const [x, y] of [[0, 0], [39, 39], [10, 15]]) {
        const X = 300 + x;
        const Y = 90 + y;
        expect(w[y * 40 + x]).toBe(Y >= 100 && Y < 120 ? 40 * (f + 1) : (X + Y + 8 * f) & 255);
      }
      expect(src.hasLevel(2)).toBe(true);
      const [c] = await src.readLevel(2, 0, 0, 256, 256, [0]);
      expect(c.length).toBe(256 * 256);
    }
  });

  it('a chip round-trips: region and frame range written as MIE4NITF, read back with the same pixels and times', async () => {
    const { m } = await open(join(FX, 'mie_multicam.ntf'));
    const eo = m.sequences[0];
    const frames = [1, 2, 3, 5];
    const out = await writeChip(eo, { x0: 90, y0: 60, w: 20, h: 10, frames, corners: frames.map(() => [[34.5, -117], [34.5, -116.99], [34.49, -116.99], [34.49, -117]]) });
    // The source's file group goes to the file header and to every frame's image subheader.
    const marked = await writeChip(eo, { x0: 90, y0: 60, w: 20, h: 10, frames: [1, 2], corners: [null, null], security: { file: { class: 'C', FSCLSY: 'US' }, image: null } });
    const sec = await openNitf(new File([marked], 'marked.ntf'), parse, { defer: isMieImage });
    expect(sec.header.security).toMatchObject({ class: 'C', FSCLSY: 'US' });
    expect(sec.images.map((im) => im.ish.security.class)).toEqual(['C', 'C']);
    const file = new File([out], 'chip.ntf');
    const r = await openNitf(file, parse, { defer: isMieImage });
    const back = await openMie(file, r, parse, { tileCache: new LRU(16 << 20) });
    expect(back.collection.warnings).toEqual([]);
    const s = back.sequences[0];
    const d = describeSequence(s);
    expect([s.width, s.height]).toEqual([20, 10]);
    expect(d.frames.map((f) => f.ns)).toEqual(frames.map((f) => truth.multicam.sequences[0].times[f]));
    for (const [i, f] of frames.entries()) {
      const [a] = await (await s.pyramid(i)).src.readWindow(0, 0, 20, 10, [0]);
      const [b] = await (await eo.pyramid(f)).src.readWindow(90, 60, 20, 10, [0]);
      expect(Array.from(a)).toEqual(Array.from(b));
    }
    // More than 999 frames would go into temporal blocks; a 4-frame chip is one segment per frame.
    expect(r.images).toHaveLength(4);
    expect(r.header.tres.map((t) => t.tag)).toEqual(['CAMSDA', 'MIMCSA', 'TMINTA', 'MTIMFA']);
  });

  it('the BAMBI campaign files (derived-mie4nitf-bambi) open as one sequence each, in time order', async () => {
    const dir = join(process.env.TE_CORPUS ?? resolve('..', 'TE-corpus'), 'derived-mie4nitf-bambi');
    const f = join(dir, 'flight_306_thermal_mie4nitf.ntf');
    if (!existsSync(f)) return;
    const { r, m } = await open(f);
    expect(m.sequences).toHaveLength(1);
    const d = describeSequence(m.sequences[0]);
    expect(d.frames.length).toBe(r.images.length);
    const ms = d.frames.map((x) => x.ms);
    expect(ms.every((t, i) => !i || t - ms[i - 1] === 500)).toBe(true);
    // Written out of time order: the frame order is not the segment order.
    expect(d.frames.map((x) => x.parts[0].seg)).not.toEqual([...d.frames.keys()]);
  });
});

// The large tiled frame on D: (build/fixtures/fx24-motion.mjs --large): a viewport reads a few tiles.
const LARGE = truth?.large?.path;
describe.skipIf(!haveWasm || !LARGE || !existsSync(LARGE ?? ''))('8192² JPEG 2000 WAMI frames (D:)', async () => {
  const { Bundle } = await import('../../app/src/wasm/abi.js');
  const { openNitf, ioStats } = await import('../../app/src/workers/decode/nitf.js');
  const { openMie, isMieImage } = await import('../../app/src/workers/decode/mie.js');
  const { LRU } = await import('../../app/src/workers/decode/pyramid.js');
  it('region decode: a 512² view tile of a frame reads and decodes only its JPEG 2000 tile; an overview only the coarse resolutions', async () => {
    const parse = new Bundle(new WebAssembly.Module(readFileSync(join(wasmDir, 'gw_bundle_parse.wasm'))), 'parse');
    const j2k = new Bundle(new WebAssembly.Module(readFileSync(join(wasmDir, 'gw_bundle_j2k.wasm'))), 'j2k');
    self.GW = { ...(self.GW ?? {}), ensure: async () => j2k };
    // A File over the disk file without reading all of it: slices read by position.
    const fd = openSync(LARGE, 'r');
    const size = statSync(LARGE).size;
    const lazy = { name: 'wami.ntf', size, lastModified: 1, slice: (a, b) => ({ arrayBuffer: async () => { const n = Math.max(0, Math.min(size, b) - a); const buf = Buffer.alloc(n); readSync(fd, buf, 0, n, a); return buf.buffer.slice(buf.byteOffset, buf.byteOffset + n); } }) };
    const r = await openNitf(lazy, parse, { defer: isMieImage });
    const m = await openMie(lazy, r, parse, { tileCache: new LRU(256 << 20) });
    const s = m.sequences[0];
    const im = r.images[2];
    const frameBytes = im.seg.dataLength;
    const pyr = await s.pyramid(2);
    const b0 = ioStats.bytes;
    const t0 = performance.now();
    const t = await pyr.tile(0, 7, 9, [0]);
    const tileMs = performance.now() - t0;
    const tileRead = ioStats.bytes - b0;
    expect(t.w).toBe(520);
    // The same frame decoded whole (what a frame cost before: one gw_j2k_decode of the codestream).
    const cs = new Uint8Array(await lazy.slice(im.seg.dataOffset, im.seg.dataOffset + frameBytes).arrayBuffer());
    const [p, n] = j2k.put(cs);
    const t1 = performance.now();
    expect(j2k.x.gw_j2k_decode(p, n, 0, 0)).toBe(0);
    const wholeMs = performance.now() - t1;
    j2k.free(p, n);
    const b2 = ioStats.bytes;
    const t2 = performance.now();
    await (await s.pyramid(3)).tile(4, 0, 0, [0]);
    const ovMs = performance.now() - t2;
    const ovRead = ioStats.bytes - b2;
    const line = `8192² frame (${frameBytes} B): 512² view tile read ${tileRead} B (${((100 * tileRead) / frameBytes).toFixed(2)} %) in ${tileMs.toFixed(0)} ms; whole-frame decode ${wholeMs.toFixed(0)} ms; level-4 overview read ${ovRead} B (${((100 * ovRead) / frameBytes).toFixed(2)} %) in ${ovMs.toFixed(0)} ms`;
    console.log(line); // the times are reported, not asserted: they vary with machine load (#70)
    // The view tile's 4-pixel gutter reaches its neighbours' cores: at most 4 of the 64 codestream tiles.
    expect(tileRead / frameBytes).toBeLessThan(4 / 64 + 0.01);
    // Resolution-first tile-parts: the overview reads only the coarse resolutions of each tile.
    expect(ovRead / frameBytes).toBeLessThan(0.1);
  }, 120000);
});
