// 2.5 streams (REQ-GAP-49, REQ-GAP-64), unit level.
// HLS: playlists (RFC 8216) and refusals by name; AES-128 decryption against segments FFmpeg
// encrypted itself; TS → fMP4 checked by decoding the fMP4 with FFmpeg (frames bit-identical to
// the source TS, same presentation times); SPS sizes against ffprobe; the HLS session's timeline
// (discontinuities stitched, synchronous KLV on its own frame) with the real Rust demuxer; a
// mutation fuzz of the playlist parser and the transmuxer. ArcGIS: portal protocol (search, web
// maps, attachments, related records with the typed checks, branch-version calls), the sign-in
// policy for a portal (the token header to the portal and the servers confirmed for it only) and
// .lyrx symbology from the CIM samples.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parsePlaylist, attrList, ivOf, pickVariant, liveStartIndex, reloadDelay, decryptSegment } from '../../app/src/media/hls.js';
import { demuxVideo, transmuxSegment, initSegment, fragment, withDurations, parseSps, nalUnits, rbsp, unwrap33, concatBytes } from '../../app/src/media/ts2mp4.js';
import { segmentTs, encrypt, seqIv } from '../tools/hls-server.mjs';
import { portalRoot, arcgisMeta, searchItems, webmapLayers, collectionLayers, queryAttachments, addAttachment, deleteAttachments, relationships, siblingUrl, relatedEdits, editResults, versionServiceUrl, listVersions, startEditing, reconcile, newSessionId, itemKind } from '../../app/src/connectors/portal.js';
import { checkEntry, SignInPolicy, TokenVault, chooseGrant } from '../../app/src/connectors/auth.js';
import { readLyrx, cimColour, labelField, missingFields, symbolStyle } from '../../app/src/formats/lyrx.js';
import { Bundle } from '../../app/src/wasm/abi.js';

const FX = resolve('fixtures', 'fx25', 'streams');
const FX10 = resolve('fixtures', 'fx10', 'fx10.ts');
const TRUTH = JSON.parse(readFileSync(resolve('fixtures', 'fx10', 'fx10_truth.json'), 'utf8'));
const FFMPEG = process.env.GW_FFMPEG ?? 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library/bin/ffmpeg.exe';
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
const haveFf = existsSync(FFMPEG) && existsSync(FFPROBE);
const DATA = process.env.GW_STREAMS_DATA ?? 'D:/gwb25/data-streams';
const TRUCK_TS = 'D:/TE-corpus/fmv-esri-truck-tutorial/FMV tutorial data/Truck.ts';
const target = (() => {
  try {
    return JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
  } catch {
    return null;
  }
})();
const wasm = (n) => join(target ?? '', 'wasm32-unknown-unknown', 'release', `gw_bundle_${n}.wasm`);
const haveParse = !!target && existsSync(wasm('parse'));

function tsIndex(parse, bytes) {
  const id = parse.x.gw_ts_open();
  const [p, n] = parse.put(bytes);
  expect(parse.x.gw_ts_push(id, p, n, 0)).toBe(0);
  parse.free(p, n);
  expect(parse.x.gw_ts_finish(id)).toBe(0);
  return parse.outJson();
}

/** Frame MD5s and presentation times of a file as FFmpeg decodes it. */
function framemd5(file) {
  const out = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const tb = /#tb 0: (\d+)\/(\d+)/.exec(out);
  const rows = out.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').map((x) => x.trim()));
  return { tb: tb ? Number(tb[1]) / Number(tb[2]) : 1, frames: rows.map((r) => ({ pts: Number(r[2]), md5: r[5] })) };
}

/** Segments → one fMP4 file (init + fragments on a zero-based timeline), as the player builds it. */
function toMp4(segs) {
  const r = segs.map((s) => transmuxSegment(s));
  const t0 = r[0].samples[0].dts;
  const out = [initSegment(r[0])];
  r.forEach((x, i) => {
    const next = r[i + 1]?.samples[0]?.dts ?? null;
    out.push(fragment({ seq: i + 1, samples: withDurations(x.samples, next).map((s) => ({ ...s, dts: s.dts - t0, pts: s.pts - t0 })), data: x.data }));
  });
  return concatBytes(out);
}

describe('HLS playlists (RFC 8216)', () => {
  it('reads attribute lists with quoted commas, hex and plain values', () => {
    expect(attrList('BANDWIDTH=800000,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360,IV=0x0A')).toEqual({ BANDWIDTH: '800000', CODECS: 'avc1.64001e,mp4a.40.2', RESOLUTION: '640x360', IV: '0x0A' });
  });

  it('reads an ffmpeg VOD playlist', () => {
    const pl = parsePlaylist(readFileSync(join(FX, 'fx10-ffmpeg', 'index.m3u8'), 'utf8'), 'http://h/s/index.m3u8');
    expect(pl.kind).toBe('media');
    expect(pl.live).toBe(false);
    expect(pl.targetDuration).toBe(2);
    expect(pl.segments.map((s) => s.uri)).toEqual([0, 1, 2, 3, 4].map((i) => `http://h/s/seg00${i}.ts`));
    expect(pl.duration).toBeCloseTo(10, 3);
  });

  it('reads a master playlist and picks a variant by bandwidth and codec', () => {
    const pl = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3300000,RESOLUTION=1280x720,CODECS="avc1.640020"\nhi/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\nlo/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,CODECS="hvc1.1.6.L120.90"\nhevc/index.m3u8\n', 'https://h/a/master.m3u8');
    expect(pl.kind).toBe('master');
    expect(pl.variants.map((v) => v.uri)).toEqual(['https://h/a/hi/index.m3u8', 'https://h/a/lo/index.m3u8', 'https://h/a/hevc/index.m3u8']);
    expect(pickVariant(pl.variants).uri).toBe('https://h/a/hi/index.m3u8'); // the H.265 one is passed over
    expect(pickVariant(pl.variants, { maxBandwidth: 1e6 }).uri).toBe('https://h/a/lo/index.m3u8');
    expect(pl.variants[0].resolution).toEqual([1280, 720]);
  });

  it('numbers live segments, discontinuities and keys; starts three target durations from the end', () => {
    const txt = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:41', '#EXT-X-DISCONTINUITY-SEQUENCE:3', '#EXT-X-KEY:METHOD=AES-128,URI="k.bin"', '#EXTINF:2,', 'a.ts', '#EXTINF:2,', 'b.ts', '#EXT-X-DISCONTINUITY', '#EXT-X-KEY:METHOD=AES-128,URI="k2.bin",IV=0x000102030405060708090a0b0c0d0e0f', '#EXT-X-PROGRAM-DATE-TIME:2026-11-03T10:00:00.000Z', '#EXTINF:2,', 'c.ts', '#EXTINF:2,', 'd.ts', ''].join('\n');
    const pl = parsePlaylist(txt, 'https://h/live/x.m3u8');
    expect(pl.live).toBe(true);
    expect(pl.segments.map((s) => [s.seq, s.disc, s.discontinuity])).toEqual([[41, 3, false], [42, 3, false], [43, 4, true], [44, 4, false]]);
    expect([...pl.segments[1].key.ivBytes]).toEqual([...ivOf(null, 42)]);
    expect(ivOf(null, 42)[15]).toBe(42);
    expect([...pl.segments[2].key.ivBytes]).toEqual([...Array(16).keys()]);
    expect(pl.segments[2].key.uri).toBe('https://h/live/k2.bin');
    expect(pl.segments[3].pdt).toBe(Date.parse('2026-11-03T10:00:02.000Z'));
    expect(liveStartIndex(pl)).toBe(1); // 6 s from the end
    expect(reloadDelay(pl, true)).toBe(2000);
    expect(reloadDelay(pl, false)).toBe(1000);
  });

  it('reads byte ranges, with and without an offset', () => {
    const pl = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-BYTERANGE:1000@0\n#EXTINF:4,\nall.ts\n#EXT-X-BYTERANGE:500\n#EXTINF:4,\nall.ts\n#EXT-X-ENDLIST\n', 'http://h/p.m3u8');
    expect(pl.segments.map((s) => s.byteRange)).toEqual([{ offset: 0, length: 1000 }, { offset: 1000, length: 500 }]);
  });

  it('refuses by name what it does not play', () => {
    const code = (txt) => {
      try {
        parsePlaylist(txt, 'http://h/p.m3u8');
        return null;
      } catch (e) {
        return e.code;
      }
    };
    expect(code('<html>')).toBe('E_HLS_NOT_PLAYLIST');
    expect(code('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\na.m4s\n')).toBe('E_HLS_FMP4');
    expect(code('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:2,\na.ts\n')).toBe('E_HLS_SAMPLE_AES');
    expect(code('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:2,\na.ts\n')).toBe('E_HLS_KEYFORMAT');
    expect(code('#EXTM3U\n#EXT-X-TARGETDURATION:2\na.ts\n')).toBe('E_HLS_EXTINF');
    expect(code('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x12\n#EXTINF:2,\na.ts\n')).toBeNull(); // a short IV is zero-padded on the left
    expect(code('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0xZZ\n#EXTINF:2,\na.ts\n')).toBe('E_HLS_IV');
    expect(code('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n')).toBe('E_HLS_NO_VARIANTS');
    expect(code('#EXTM3U\n#EXT-X-BYTERANGE:10\n#EXTINF:2,\na.ts\n')).toBe('E_HLS_BYTERANGE');
  });
});

describe('AES-128 segments (oracle: FFmpeg encrypted them)', () => {
  it('decrypts every ffmpeg-encrypted segment to the bytes of the unencrypted run', async () => {
    const dir = join(FX, 'fx10-aes');
    const pl = parsePlaylist(readFileSync(join(dir, 'index.m3u8'), 'utf8'), 'http://h/aes/index.m3u8');
    const key = new Uint8Array(readFileSync(join(dir, 'key.bin')));
    for (const s of pl.segments) {
      const name = s.uri.split('/').pop();
      const plain = await decryptSegment(new Uint8Array(readFileSync(join(dir, name))), key, s.key.ivBytes);
      expect(Buffer.from(plain).equals(readFileSync(join(FX, 'fx10-ffmpeg', name))), name).toBe(true);
    }
  });

  it('decrypts with the media-sequence IV and names a wrong key', async () => {
    const seg = segmentTs(readFileSync(FX10), 2)[1].bytes;
    const key = Buffer.alloc(16, 7);
    const enc = encrypt(seg, key, seqIv(5));
    expect(Buffer.from(await decryptSegment(new Uint8Array(enc), new Uint8Array(key), ivOf(null, 5))).equals(Buffer.from(seg))).toBe(true);
    await expect(decryptSegment(new Uint8Array(enc), new Uint8Array(Buffer.alloc(16, 8)), ivOf(null, 5))).rejects.toMatchObject({ code: 'E_HLS_DECRYPT' });
    await expect(decryptSegment(new Uint8Array(enc), new Uint8Array(8), ivOf(null, 5))).rejects.toMatchObject({ code: 'E_HLS_KEY_SIZE' });
  });
});

describe('TS → fMP4 (oracle: FFmpeg decodes the fMP4)', () => {
  it.skipIf(!haveFf)('ffmpeg HLS segments of fx10: 300 frames bit-identical to the TS, same presentation times', () => {
    const dir = join(FX, 'fx10-ffmpeg');
    const segs = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort().map((f) => new Uint8Array(readFileSync(join(dir, f))));
    const tmp = mkdtempSync(join(tmpdir(), 'gw25-'));
    try {
      const mp4 = join(tmp, 'a.mp4');
      writeFileSync(mp4, toMp4(segs));
      const a = framemd5(mp4);
      const b = framemd5(FX10);
      expect(a.frames.length).toBe(300);
      expect(a.frames.map((f) => f.md5)).toEqual(b.frames.map((f) => f.md5));
      const rel = (x) => x.frames.map((f) => Math.round((f.pts - x.frames[0].pts) * x.tb * 90000));
      expect(rel(a)).toEqual(rel(b));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(!haveFf || !existsSync(join(DATA, 'truck-h264-hls', 'hi')))('SCN-30 truck re-encoded with libx264 (720p, 2 s segments): every frame bit-identical', () => {
    const dir = join(DATA, 'truck-h264-hls', 'hi');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
    const tmp = mkdtempSync(join(tmpdir(), 'gw25-'));
    try {
      const mp4 = join(tmp, 'a.mp4');
      writeFileSync(mp4, toMp4(files.map((f) => new Uint8Array(readFileSync(join(dir, f))))));
      const cat = join(tmp, 'all.ts');
      writeFileSync(cat, Buffer.concat(files.map((f) => readFileSync(join(dir, f)))));
      const a = framemd5(mp4);
      const b = framemd5(cat);
      expect(a.frames.length).toBeGreaterThan(1700);
      expect(a.frames.map((f) => f.md5)).toEqual(b.frames.map((f) => f.md5));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120000);

  it.skipIf(!haveFf || !existsSync(TRUCK_TS))('Truck.ts (1080p, synchronous KLV) cut by the test segmenter: frames bit-identical, SPS size with cropping', () => {
    const buf = readFileSync(TRUCK_TS).subarray(0, 188 * 60000); // the first ~11 MB
    const segs = segmentTs(buf, 2).slice(0, -1); // the last one is cut short
    const tmp = mkdtempSync(join(tmpdir(), 'gw25-'));
    try {
      const mp4 = join(tmp, 'a.mp4');
      writeFileSync(mp4, toMp4(segs.map((s) => s.bytes)));
      const ts = join(tmp, 'a.ts');
      writeFileSync(ts, Buffer.concat(segs.map((s) => Buffer.from(s.bytes))));
      const a = framemd5(mp4);
      const b = framemd5(ts);
      expect(a.frames.length).toBe(b.frames.length);
      expect(a.frames.map((f) => f.md5)).toEqual(b.frames.map((f) => f.md5));
      const info = transmuxSegment(segs[0].bytes).info;
      expect([info.width, info.height]).toEqual([1920, 1080]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120000);

  it.skipIf(!haveFf)('SPS profile, level and size match ffprobe', () => {
    const r = transmuxSegment(new Uint8Array(readFileSync(FX10)));
    const p = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,profile,level', '-of', 'json', FX10], { encoding: 'utf8' })).streams[0];
    expect([r.info.width, r.info.height, r.info.level]).toEqual([p.width, p.height, p.level]);
    expect(r.info.profile).toBe(100); // High
    expect(r.mime).toBe('avc1.64001E');
  });

  it('unwraps 33-bit time stamps and removes emulation prevention bytes', () => {
    expect(unwrap33(10, 2 ** 33 - 5)).toBe(2 ** 33 + 10);
    expect(unwrap33(2 ** 33 - 5, 10)).toBe(-5);
    expect([...rbsp(new Uint8Array([1, 0, 0, 3, 1, 0, 0, 3, 0, 0, 3]))]).toEqual([1, 0, 0, 1, 0, 0, 0, 0]);
    expect(nalUnits(new Uint8Array([0, 0, 0, 1, 9, 0x10, 0, 0, 1, 0x67, 1, 2, 0, 0]))).toEqual([new Uint8Array([9, 0x10]), new Uint8Array([0x67, 1, 2])]);
  });

  it('names MPEG-2 and H.265 segments instead of transmuxing them', () => {
    // fx10 with its stream type patched to MPEG-2 (0x02) and to H.265 (0x24).
    const b = new Uint8Array(readFileSync(FX10)).slice(0, 188 * 50);
    const d = demuxVideo(b);
    expect(d.video).toMatchObject({ codec: 'avc1', pid: 256 });
    for (const [type, codec] of [[0x02, 'mp2v'], [0x24, 'hvc1']]) {
      const c = b.slice();
      for (let o = 0; o < c.length; o += 188) if ((((c[o + 1] & 0x1f) << 8) | c[o + 2]) === 4096) for (let q = o + 5; q < o + 188; q++) if (c[q] === 0x1b && c[q + 1] === 0xe1 && c[q + 2] === 0x00) c[q] = type; // PMT PID 0x1000
      expect(transmuxSegment(c).codec).toBe(codec);
      expect(transmuxSegment(c).samples).toEqual([]);
    }
  });
});

describe.skipIf(!haveParse)('the HLS session timeline (real Rust demuxer, the player code)', async () => {
  const parse = haveParse ? new Bundle(new WebAssembly.Module(readFileSync(wasm('parse'))), 'parse') : null;
  const { HlsSession } = await import('../../app/src/features/hls-player.js');

  /** A session over in-memory segments: the worker step runs in-process (tsindex + transmux). */
  function session(segBytes, playlistText) {
    const app = {
      netlog: { fetchFor: () => async (u) => (u.endsWith('.m3u8') ? new Response(playlistText) : new Response(segBytes[Number(/s(\d+)\.ts$/.exec(u)[1])])) },
      pool: { run: async (op, { bytes }) => { const b = new Uint8Array(bytes); const tm = transmuxSegment(b); return { idx: tsIndex(parse, b), ...tm }; } },
      fmv: { rebuildStates: () => {} },
      log: () => {},
      toast: () => {},
    };
    return new HlsSession(app, 'http://h/x/index.m3u8');
  }

  it('fx10 twice with a discontinuity: one continuous timeline, every synchronous KLV packet on its own frame', async () => {
    const segs = segmentTs(readFileSync(FX10), 2);
    const all = [...segs, ...segs];
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:3', '#EXT-X-MEDIA-SEQUENCE:0'];
    all.forEach((s, i) => lines.push(...(i === segs.length ? ['#EXT-X-DISCONTINUITY'] : []), `#EXTINF:${s.duration},`, `s${i}.ts`));
    lines.push('#EXT-X-ENDLIST');
    const s = session(all.map((x) => x.bytes), lines.join('\n'));
    s.pl = parsePlaylist(lines.join('\n'), 'http://h/x/index.m3u8');
    s.seen(s.pl);
    s.startSeq = 0;
    for (const seg of s.pl.segments) {
      const st = s.segs.get(seg.seq);
      const r = await s.load(st);
      s.place(st, r);
      if (!s.clip) s.makeClip(r);
      else s.addMedia(st, r);
    }
    const c = s.clip;
    expect(c.frames.length).toBe(600);
    expect(c.packets.length).toBe(600);
    expect(s.stats.discontinuities).toBe(1);
    // Frames 1/30 s apart throughout, across the discontinuity too.
    const gaps = c.frames.slice(1).map((f, i) => Math.round((f.t - c.frames[i].t) * 30000));
    expect(new Set(gaps)).toEqual(new Set([1000]));
    // Synchronous KLV: each packet's time is a frame's time (the same PES PTS), one packet per
    // frame, in both loops.
    const ft = c.frames.map((f) => f.t).sort((x, y) => x - y);
    const kt = c.packets.map((k) => k.tMux).sort((x, y) => x - y);
    let off = 0;
    for (let i = 0; i < 600; i++) off = Math.max(off, Math.abs(kt[i] - ft[i]));
    expect(off).toBeLessThan(1e-9);
    expect(c.packets.every((k) => k.ok)).toBe(true);
    expect(TRUTH.frames.length).toBe(300);
    expect(c.packets.filter((k) => k.disc === 1).length).toBe(300);
  });

  it('the KLV packets of the segments equal the whole file’s, byte for byte', () => {
    const file = new Uint8Array(readFileSync(FX10));
    const whole = tsIndex(parse, file).klv.flatMap((r) => r.packets);
    const parts = segmentTs(file, 2).flatMap((s) => tsIndex(parse, s.bytes).klv.flatMap((r) => r.packets));
    expect(parts.length).toBe(whole.length);
    expect(JSON.stringify(parts)).toBe(JSON.stringify(whole));
  });
});

describe('fuzz: mutated playlists and segments (seeded)', () => {
  let seed = 0x2545;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  it('parsePlaylist returns or refuses by name on 3000 mutations', () => {
    const base = readFileSync(join(FX, 'fx10-aes', 'index.m3u8'), 'utf8') + '#EXT-X-BYTERANGE:10@5\n#EXT-X-DISCONTINUITY\n';
    const chars = '#:,="\n-0123456789ABCDEFXabcdefx@./ ';
    for (let k = 0; k < 3000; k++) {
      const a = base.split('');
      for (let m = 0; m < 1 + Math.floor(rnd() * 6); m++) {
        const i = Math.floor(rnd() * a.length);
        const op = rnd();
        if (op < 0.4) a[i] = chars[Math.floor(rnd() * chars.length)];
        else if (op < 0.7) a.splice(i, 1 + Math.floor(rnd() * 8));
        else a.splice(i, 0, ...a.slice(Math.floor(rnd() * a.length), Math.floor(rnd() * a.length)));
      }
      try {
        parsePlaylist(a.join(''), 'http://h/p.m3u8');
      } catch (e) {
        expect(e.code ?? e.message, a.join('').slice(0, 200)).toMatch(/^E_HLS_|^E_/);
      }
    }
  });

  it('transmuxSegment never throws and writes well-formed boxes on 400 damaged segments', () => {
    const seg = segmentTs(readFileSync(FX10), 2)[1].bytes;
    const boxesOk = (b) => {
      let o = 0;
      while (o < b.length) {
        const n = new DataView(b.buffer, b.byteOffset + o).getUint32(0);
        if (n < 8 || o + n > b.length) return false;
        o += n;
      }
      return o === b.length;
    };
    for (let k = 0; k < 400; k++) {
      const c = seg.slice(0, Math.floor(seg.length * (0.3 + 0.7 * rnd())));
      for (let m = 0; m < 1 + Math.floor(rnd() * 40); m++) c[Math.floor(rnd() * c.length)] = Math.floor(rnd() * 256);
      const r = transmuxSegment(c);
      if (!r.samples.length || !r.sps.length || !r.pps.length) continue;
      const f = fragment({ seq: 1, samples: withDurations(r.samples).map((s) => ({ ...s, dts: s.dts - r.samples[0].dts + 90000, pts: s.pts - r.samples[0].dts + 90000 })), data: r.data });
      expect(boxesOk(f)).toBe(true);
      try {
        expect(boxesOk(initSegment(r))).toBe(true);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  it('parseSps refuses damaged parameter sets with an error, never a hang', () => {
    const sps = transmuxSegment(new Uint8Array(readFileSync(FX10))).sps[0];
    for (let k = 0; k < 500; k++) {
      const c = sps.slice(0, 1 + Math.floor(rnd() * sps.length));
      for (let m = 0; m < 3; m++) c[1 + Math.floor(rnd() * (c.length - 1))] ^= 1 << Math.floor(rnd() * 8);
      try {
        const s = parseSps(c);
        expect(Number.isFinite(s.width)).toBe(true);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });
});

// ---------------------------------------------------------------- ArcGIS portals

/** In-memory REST: a map from path to a JSON reply (or a function of the URL / body). */
function rest(routes, seen = []) {
  const get = async (u) => {
    const url = new URL(u);
    seen.push({ method: 'GET', path: url.pathname, q: Object.fromEntries(url.searchParams) });
    const r = routes[url.pathname];
    return typeof r === 'function' ? r(url) : r ?? { error: { code: 404, message: 'not found' } };
  };
  const post = async (u, body) => {
    const url = new URL(u);
    const fields = body instanceof URLSearchParams ? Object.fromEntries(body) : Object.fromEntries([...body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : { name: v.name, size: v.size }]));
    seen.push({ method: 'POST', path: url.pathname, body: fields });
    const r = routes[`POST ${url.pathname}`];
    return typeof r === 'function' ? r(url, fields) : r ?? { error: { code: 404, message: 'not found' } };
  };
  return { get, post, seen };
}

describe('ArcGIS portal protocol', () => {
  it('normalises portal addresses and gives the OAuth endpoints (no device grant)', () => {
    expect(portalRoot('https://www.arcgis.com/home/item.html?id=x')).toBe('https://www.arcgis.com');
    expect(portalRoot('https://org.maps.arcgis.com/sharing/rest/search')).toBe('https://org.maps.arcgis.com');
    expect(portalRoot('https://gis.example.org/portal/home/')).toBe('https://gis.example.org/portal');
    expect(() => portalRoot('http://gis.example.org/portal')).toThrow(expect.objectContaining({ code: 'E_PORTAL_NOT_HTTPS' }));
    const m = arcgisMeta('https://gis.example.org/portal');
    expect(m.token_endpoint).toBe('https://gis.example.org/portal/sharing/rest/oauth2/token');
    expect(m.device_authorization_endpoint).toBeUndefined();
    // From a file opened from disk, PKCE with the out-of-band code; there is no device grant to ask for.
    expect(chooseGrant(m, { protocol: 'file:' })).toBe('pkce');
    expect(chooseGrant(m, { wanted: 'device', protocol: 'file:' })).toBeNull();
  });

  it('searches with a type filter and pages', async () => {
    const r = rest({ '/sharing/rest/search': (u) => ({ total: 45, start: Number(u.searchParams.get('start')), num: 20, nextStart: 21, results: [{ id: 'a'.repeat(32), title: 'Roads', type: 'Feature Service', url: 'https://s/arcgis/rest/services/R/FeatureServer' }, { id: 'b'.repeat(32), title: 'Doc', type: 'PDF' }] }) });
    const s = await searchItems(r.get, 'https://p', { q: 'roads', types: ['Feature Service', 'Web Map'], start: 1 });
    expect(r.seen[0].q.q).toBe('(roads) AND (type:"Feature Service" OR type:"Web Map")');
    expect(s.results.map((x) => x.kind)).toEqual(['feature', null]);
    expect(s.nextStart).toBe(21);
    expect(itemKind({ type: 'Web Map' })).toBe('webmap');
  });

  it('lists a web map’s layers, opening group layers and naming what is refused', () => {
    const l = webmapLayers({ operationalLayers: [{ title: 'G', layerType: 'GroupLayer', layers: [{ title: 'Units', layerType: 'ArcGISFeatureLayer', url: 'https://s/x/FeatureServer/0', layerDefinition: { definitionExpression: 'A>1' } }] }, { title: 'CSV', layerType: 'CSV', url: 'https://s/a.csv' }, { title: 'Img', url: 'https://s/arcgis/rest/services/I/ImageServer' }, { title: 'Sketch', featureCollection: { layers: [] } }, { title: 'Traffic', layerType: 'ArcGISMapServiceLayer', url: 'https://t/arcgis/rest/services/World/Traffic/MapServer', layers: [{ id: 2, layerDefinition: {} }] }], baseMap: { baseMapLayers: [{ title: 'Topo', layerType: 'ArcGISTiledMapServiceLayer', url: 'https://t/MapServer' }] } });
    expect(l.map((x) => [x.title, x.kind, x.path.join('/'), x.basemap, x.refused])).toEqual([['Units', 'feature', 'G', false, null], ['CSV', null, '', false, 'layer type CSV'], ['Img', 'image', '', false, null], ['Sketch', 'collection', '', false, null], ['Traffic', 'map', '', false, null], ['Topo', 'map', '', true, null]]);
    expect(l[0].definitionExpression).toBe('A>1');
    expect(collectionLayers({ layers: [{ layerDefinition: { name: 'N' }, featureSet: { geometryType: 'esriGeometryPoint', features: [{}] } }] })[0]).toMatchObject({ name: 'N', geometryType: 'esriGeometryPoint' });
  });

  it('queries attachments by layer or per feature, adds and deletes them', async () => {
    const layer = 'https://s/arcgis/rest/services/U/FeatureServer/0';
    const r = rest({
      '/arcgis/rest/services/U/FeatureServer/0/queryAttachments': { attachmentGroups: [{ parentObjectId: 1, attachmentInfos: [{ id: 5, name: 'a.jpg', contentType: 'image/jpeg', size: 10 }] }] },
      '/arcgis/rest/services/U/FeatureServer/0/2/attachments': { attachmentInfos: [{ id: 6, name: 'b.pdf', contentType: 'application/pdf', size: 20 }] },
      'POST /arcgis/rest/services/U/FeatureServer/0/1/addAttachment': { addAttachmentResult: { objectId: 7, globalId: '{X}', success: true } },
      'POST /arcgis/rest/services/U/FeatureServer/0/1/deleteAttachments': (u, b) => ({ deleteAttachmentResults: b.attachmentIds.split(',').map((id) => ({ objectId: Number(id), success: id !== '9' })) }),
    });
    const a = await queryAttachments(r.get, layer, { hasAttachments: true, advancedQueryCapabilities: { supportsQueryAttachments: true } }, [1]);
    expect(a.get(1)[0]).toMatchObject({ id: 5, url: `${layer}/1/attachments/5` });
    const b = await queryAttachments(r.get, layer, { hasAttachments: true }, [2]);
    expect(b.get(2)[0].name).toBe('b.pdf');
    await expect(queryAttachments(r.get, layer, { hasAttachments: false }, [1])).rejects.toMatchObject({ code: 'E_ARCGIS_NO_ATTACHMENTS' });
    expect(await addAttachment(r.post, layer, 1, new File([new Uint8Array(3)], 'c.png'))).toEqual({ id: 7, globalId: '{X}' });
    expect(r.seen.at(-1).body.attachment).toEqual({ name: 'c.png', size: 3 });
    expect(await deleteAttachments(r.post, layer, 1, [5])).toEqual([5]);
    await expect(deleteAttachments(r.post, layer, 1, [5, 9])).rejects.toMatchObject({ code: 'E_ARCGIS_ATTACHMENT' });
    await expect(queryAttachments(r.get, layer, {}, ['1 OR 1=1'])).rejects.toMatchObject({ code: 'E_ARCGIS_OID' });
  });

  it('checks related record edits against the related table before sending (REQ-GAP-63 checks)', () => {
    const rel = relationships({ relationships: [{ id: 0, name: 'Unit_Inspections', relatedTableId: 1, cardinality: 'esriRelCardinalityOneToMany', role: 'esriRelRoleOrigin', keyField: 'GlobalID', keyFieldInRelationshipTable: 'UNIT_GUID' }] })[0];
    const table = { objectIdField: 'OBJECTID', fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID' }, { name: 'UNIT_GUID', type: 'esriFieldTypeGUID' }, { name: 'RESULT', type: 'esriFieldTypeString', nullable: false, domain: { type: 'codedValue', codedValues: [{ code: 'pass' }, { code: 'fail' }] } }, { name: 'SCORE', type: 'esriFieldTypeSmallInteger', domain: { type: 'range', range: [0, 10] } }, { name: 'INSPECTED', type: 'esriFieldTypeDate' }] };
    const ok = relatedEdits(rel, table, { GlobalID: '{G-1}' }, { adds: [{ RESULT: 'pass', SCORE: '7', INSPECTED: '2024-06-01T00:00:00Z' }], updates: [{ OBJECTID: 2, SCORE: 4 }], deletes: [3] });
    expect(ok.adds[0].attributes).toEqual({ RESULT: 'pass', SCORE: 7, INSPECTED: Date.UTC(2024, 5, 1), UNIT_GUID: '{G-1}' });
    expect(ok.updates[0].attributes).toEqual({ SCORE: 4, OBJECTID: 2 });
    let e = null;
    try {
      relatedEdits(rel, table, { GlobalID: '{G-1}' }, { adds: [{ RESULT: 'maybe', SCORE: 11 }, { SCORE: 1 }], updates: [{ OBJECTID: 2, COLOUR: 'x' }] });
    } catch (x) {
      e = x;
    }
    expect(e.code).toBe('E_ATTRS_INVALID');
    expect(e.issues.map((x) => x.code)).toEqual(['E_ATTR_DOMAIN', 'E_ATTR_RANGE', 'E_ATTR_REQUIRED', 'E_ATTR_UNKNOWN']);
    expect(() => relatedEdits(rel, table, { GlobalID: '{G-1}' }, { updates: [{ OBJECTID: 2, UNIT_GUID: '{G-2}' }] })).toThrow(expect.objectContaining({ code: 'E_ARCGIS_REL_KEY' }));
    expect(() => relatedEdits({ ...rel, cardinality: 'esriRelCardinalityManyToMany' }, table, { GlobalID: 'x' }, {})).toThrow(expect.objectContaining({ code: 'E_ARCGIS_REL_MANY' }));
    expect(() => relatedEdits(rel, table, {}, { adds: [{}] })).toThrow(expect.objectContaining({ code: 'E_ARCGIS_REL_KEY' }));
    expect(siblingUrl('https://s/arcgis/rest/services/U/FeatureServer/0', 1)).toBe('https://s/arcgis/rest/services/U/FeatureServer/1');
    expect(() => editResults({ addResults: [{ success: false, error: { description: 'bad' } }] }, 'T')).toThrow(expect.objectContaining({ code: 'E_EDITS_REFUSED' }));
  });

  it('calls the Version Management Service with a braced session ID', async () => {
    const vms = versionServiceUrl('https://s/server/rest/services/U/FeatureServer/0');
    expect(vms).toBe('https://s/server/rest/services/U/VersionManagementServer');
    expect(() => versionServiceUrl('https://s/server/rest/services/U/MapServer/0')).toThrow(expect.objectContaining({ code: 'E_ARCGIS_URL' }));
    const g = '5E3C2B11-7F6D-4E1A-9C2B-1A2B3C4D5E6F';
    const r = rest({ '/server/rest/services/U/VersionManagementServer/versionInfos': { versions: [{ versionName: 'sde.DEFAULT', versionGuid: '{BD3F4817-9A00-41AC-B0CC-58F78DBAE0A1}' }, { versionName: 'ed.work', versionGuid: `{${g}}` }] }, [`POST /server/rest/services/U/VersionManagementServer/versions/${g}/startEditing`]: { success: true }, [`POST /server/rest/services/U/VersionManagementServer/versions/${g}/reconcile`]: { success: true, hasConflicts: true, moment: 5 } });
    const list = await listVersions(r.get, vms);
    expect(list.map((v) => [v.name, v.isDefault, v.owner])).toEqual([['sde.DEFAULT', true, 'sde'], ['ed.work', false, 'ed']]);
    const sid = newSessionId(() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(sid).toBe('{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}');
    await startEditing(r.post, vms, `{${g.toLowerCase()}}`, sid);
    expect(r.seen.at(-1)).toMatchObject({ path: `/server/rest/services/U/VersionManagementServer/versions/${g}/startEditing`, body: { f: 'json', sessionId: sid } });
    expect(await reconcile(r.post, vms, g, sid, { withPost: false })).toEqual({ hasConflicts: true, didPost: false, moment: 5 });
    expect(r.seen.at(-1).body).toMatchObject({ abortIfConflicts: 'true', withPost: 'false', conflictDetection: 'byObject' });
    await expect(startEditing(r.post, vms, 'nope', sid)).rejects.toMatchObject({ code: 'E_ARCGIS_VERSION' });
  });
});

describe('portal sign-in policy (REQ-GAP-09 routes, OD-2.19)', () => {
  const portal = 'https://org.example.com';
  const host = 'https://services.example.com';
  function policyWith(entry) {
    let list = [];
    const vault = new TokenVault({ fetch: async () => new Response('{}') });
    const p = new SignInPolicy({ store: { get: () => list, set: (v) => (list = v) }, vault });
    p.set(entry);
    vault.set(portal, { access_token: 'AT-1', expires_in: 1800, refresh_token: 'RT-1' }, { meta: arcgisMeta(portal), clientId: 'c' });
    return { p, vault };
  }

  it('keeps an ArcGIS entry with its header and confirmed servers; refuses wildcards and http', () => {
    const e = checkEntry({ origin: portal, oidc: { issuer: portal, clientId: 'c', kind: 'arcgis', alsoFor: [host, `${host}/x`, portal] } });
    expect(e.oidc).toMatchObject({ kind: 'arcgis', header: 'X-Esri-Authorization', alsoFor: [host], scope: '' });
    expect(() => checkEntry({ origin: portal, oidc: { issuer: portal, clientId: 'c', kind: 'arcgis', alsoFor: ['https://*.example.com'] } })).toThrow(expect.objectContaining({ code: 'E_AUTH_WILDCARD' }));
    expect(() => checkEntry({ origin: portal, oidc: { issuer: portal, clientId: 'c', kind: 'arcgis', alsoFor: ['http://services.example.com'] } })).toThrow(expect.objectContaining({ code: 'E_AUTH_INSECURE_ORIGIN' }));
  });

  it('sends the token in X-Esri-Authorization to the portal and the confirmed server only, never in the URL', async () => {
    const { p } = policyWith({ origin: portal, oidc: { issuer: portal, clientId: 'c', kind: 'arcgis', alsoFor: [host] } });
    const a = await p.prepare(`${portal}/sharing/rest/portals/self?f=json`);
    expect(new Headers(a.init.headers).get('X-Esri-Authorization')).toBe('Bearer AT-1');
    expect(new Headers(a.init.headers).get('Authorization')).toBeNull();
    const b = await p.prepare(`${host}/server/rest/services/U/FeatureServer/0?f=json`);
    expect(new Headers(b.init.headers).get('X-Esri-Authorization')).toBe('Bearer AT-1');
    expect(b.owner).toBe(portal);
    const c = await p.prepare('https://other.example.com/arcgis/rest/services/X/MapServer?f=json');
    expect(c.init.headers).toBeUndefined();
    expect(c.how).toBeNull();
    // A caller's own header is never replaced.
    const d = await p.prepare(`${host}/x`, { headers: { 'X-Esri-Authorization': 'Bearer typed' } });
    expect(new Headers(d.init.headers).get('X-Esri-Authorization')).toBe('Bearer typed');
    expect(d.how).toBeNull();
  });

  it('revokes the refresh token with ArcGIS’s auth_token parameter on sign-out', async () => {
    const calls = [];
    const vault = new TokenVault({ fetch: async (u, init) => (calls.push({ u, body: String(init.body) }), new Response('{"success":true}')) });
    vault.set(portal, { access_token: 'AT', expires_in: 1800, refresh_token: 'RT' }, { meta: arcgisMeta(portal), clientId: 'c' });
    await vault.signOut(portal);
    expect(calls[0].u).toBe(`${portal}/sharing/rest/oauth2/revokeToken`);
    expect(new URLSearchParams(calls[0].body).get('auth_token')).toBe('RT');
  });
});

describe('.lyrx symbology (CIM samples written from the specification)', () => {
  const L = (f) => readLyrx(readFileSync(resolve('fixtures', 'fx25', 'streams', 'lyrx', f), 'utf8'));

  it('converts CIM colours', () => {
    expect(cimColour({ type: 'CIMRGBColor', values: [255, 0, 0, 100] }).colour).toBe('#ff0000');
    expect(cimColour({ type: 'CIMRGBColor', values: [0, 112, 255, 40] }).colour).toBe('#0070ff66');
    expect(cimColour({ type: 'CIMHSVColor', values: [120, 100, 100, 100] }).colour).toBe('#00ff00');
    expect(cimColour({ type: 'CIMCMYKColor', values: [0, 100, 100, 0, 100] }).colour).toBe('#ff0000');
    expect(cimColour({ type: 'CIMGrayColor', values: [128, 50] }).colour).toBe('#80808080');
    expect(cimColour({ type: 'CIMLABColor', values: [50, 0, 0] }).reason).toBe('colour model CIMLABColor');
    expect(['$feature.NAME', '[NAME]', '$feature["NAME"]', 'Upper($feature.NAME)'].map(labelField)).toEqual(['NAME', 'NAME', 'NAME', null]);
  });

  it('unique values: rules per value, a dash, labels; the hatch fill, casing and definition query refused by name', () => {
    const d = L('units-unique.lyrx');
    const l = d.layers[0];
    expect(l.geometry).toBe('polygon');
    expect(l.styleRules.map((r) => [r.filter.field, r.filter.op, r.filter.value])).toEqual([['STATUS', '=', 'A'], ['STATUS', '=', 'I'], ['STATUS', '=', 'R']]);
    expect(l.styleRules[0].style).toMatchObject({ outline: '#0070ff', stroke: '#0070ff', fill: '#0070ff66', width: 2 });
    expect(l.styleRules[1].style.dash).toEqual([16 / 3, 8 / 3]);
    expect(l.style).toMatchObject({ labelField: 'NAME', labelSize: 12, labelColour: '#141478', fill: '#c8c8c880' });
    expect(l.refused.map((r) => r.reason)).toEqual(['extra stroke layer', 'symbol layer CIMHatchFill', 'definition query STRENGTH > 0']);
    expect(missingFields(l, ['status', 'Name'])).toEqual([]);
    expect(missingFields(l, ['NAME'])).toEqual(['STATUS']);
  });

  it('class breaks: ordered ≤ rules after a below-minimum rule, transparency applied', () => {
    const l = L('units-breaks.lyrx').layers[0];
    expect(l.styleRules.map((r) => [r.filter.op, r.filter.value])).toEqual([['<', 0], ['≤', 25], ['≤', 50], ['≤', 100]]);
    expect(l.styleRules[3].style.fill).toBe('#ff0000cc'); // CMYK red at 80 % opacity
    expect(l.refused).toEqual([]);
  });

  it('points: the vector marker’s colour and size; the heat map and raster layers refused', () => {
    const d = L('points-simple.lyrx');
    expect(d.layers.map((l) => l.name)).toEqual(['Detections', 'Heat']);
    expect(d.layers[0].style).toMatchObject({ stroke: '#009600', outline: '#ffffff', labelField: 'CLASS', radius: 16 / 3 });
    expect(d.layers[0].refused.map((r) => r.reason)).toEqual(['marker shape (drawn as a circle)']);
    expect(d.layers[1].refused.map((r) => r.reason)).toEqual(['renderer CIMHeatMapRenderer']);
    expect(d.refused).toEqual([{ name: 'Imagery', type: 'CIMRasterLayer' }]);
    expect(() => L('not-a-layer.lyrx')).toThrow(expect.objectContaining({ code: 'E_LYRX_TYPE' }));
    expect(() => readLyrx('\u0000binary lyr')).toThrow(expect.objectContaining({ code: 'E_LYRX_JSON' }));
    expect(symbolStyle({ type: 'CIMSymbolReference', symbol: { type: 'CIMMeshSymbol' } }).refused).toEqual([{ src: 'symbol type {type}', params: { type: 'CIMMeshSymbol' } }]);
  });
});
