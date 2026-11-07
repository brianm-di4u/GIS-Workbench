// REQ-GAP-49 test streams (2.5 group streams), made with FFmpeg 9.0.2 from the gw-te environment
// (GPL build, test time only; nothing it makes is bundled):
//   fixtures/fx25/streams/fx10-ffmpeg/   fx10.ts (H.264, ST 0601) as ffmpeg's own HLS VOD (2 s);
//                                         ffmpeg writes the KLV as asynchronous (0x06 KLVA)
//   fixtures/fx25/streams/fx10-aes/       the same, AES-128 encrypted by ffmpeg (hls_key_info_file)
//   D:\gwb25\data-streams\truck-mpeg2-hls\  SCN-30 truck_mpeg2_klv.ts as MPEG-2 HLS VOD (stream copy)
//   D:\gwb25\data-streams\truck-h264-hls\   the same video re-encoded with libx264 at two sizes,
//                                         KLV copied, under a master playlist (two variants)
// Synchronous KLV (stream type 0x15) is kept only by the test server's own segmenter
// (tests/tools/hls-server.mjs segmentTs), which the tests run on fx10.ts and Truck.ts directly.
// SHA-256 of every output goes to D:\gwb25\data-streams\SOURCES.json and the fixture SOURCE.txt.
//
//   node build/fixtures/fx25-streams.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = resolve('.');
const FF = process.env.GW_FFMPEG ?? 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library/bin/ffmpeg.exe';
const FIX = join(ROOT, 'fixtures', 'fx25', 'streams');
const DATA = process.env.GW_STREAMS_DATA ?? 'D:/gwb25/data-streams';
const FX10 = join(ROOT, 'fixtures', 'fx10', 'fx10.ts');
const TRUCK2 = 'D:/TE-corpus/derived-fmv-variants/truck_mpeg2_klv.ts';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const ff = (args) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const fresh = (d) => {
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
};
const files = [];
const record = (dir, how) => {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) continue;
    files.push({ file: p.replace(/\\/g, '/'), bytes: statSync(p).size, sha256: sha(p), how });
  }
};

// fx10 through ffmpeg's HLS muxer.
const a = join(FIX, 'fx10-ffmpeg');
fresh(a);
ff(['-i', FX10, '-map', '0', '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(a, 'seg%03d.ts'), join(a, 'index.m3u8')]);
record(a, 'ffmpeg -i fx10.ts -map 0 -c copy -f hls -hls_time 2 -hls_playlist_type vod');

// The same, AES-128: a fixed test key (16 bytes, below) and an explicit IV written by ffmpeg.
const b = join(FIX, 'fx10-aes');
fresh(b);
const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'); // a test key, not a secret
writeFileSync(join(b, 'key.bin'), key);
const info = join(FIX, 'keyinfo.txt');
writeFileSync(info, `key.bin\n${join(b, 'key.bin')}\n00000000000000000000000000000abc\n`);
ff(['-i', FX10, '-map', '0', '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_key_info_file', info, '-hls_segment_filename', join(b, 'seg%03d.ts'), join(b, 'index.m3u8')]);
rmSync(info);
record(b, 'ffmpeg … -hls_key_info_file (key 000102…0f, IV 0x…0abc)');
writeFileSync(join(FIX, 'SOURCE.txt'), ['REQ-GAP-49 HLS fixtures, generated (not downloaded) by build/fixtures/fx25-streams.mjs from fixtures/fx10/fx10.ts (own synthetic stream).', 'Tool: FFmpeg 9.0.2 (gw-te conda environment), test time only.', 'fx10-aes/key.bin is a fixed test key.', '', ...files.filter((f) => f.file.includes('/fixtures/')).map((f) => `${f.file.slice(f.file.indexOf('fixtures/'))}  ${f.bytes}  sha256 ${f.sha256}`), ''].join('\n'));

// Corpus SCN-30 (large: D: only).
if (existsSync(TRUCK2)) {
  const c = join(DATA, 'truck-mpeg2-hls');
  fresh(c);
  ff(['-i', TRUCK2, '-map', '0', '-c', 'copy', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(c, 'seg%03d.ts'), join(c, 'index.m3u8')]);
  record(c, 'ffmpeg -i truck_mpeg2_klv.ts -map 0 -c copy -f hls -hls_time 4 -hls_playlist_type vod');
  const d = join(DATA, 'truck-h264-hls');
  fresh(d);
  for (const [name, size, rate] of [['hi', '1280:720', '3000k'], ['lo', '640:360', '800k']]) {
    mkdirSync(join(d, name), { recursive: true });
    ff(['-i', TRUCK2, '-map', '0:v:0', '-map', '0:d?', '-vf', `scale=${size}`, '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-b:v', rate, '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-c:d', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(d, name, 'seg%03d.ts'), join(d, name, 'index.m3u8')]);
    record(join(d, name), `ffmpeg -i truck_mpeg2_klv.ts -vf scale=${size} -c:v libx264 -preset veryfast -b:v ${rate} -g 30 -c:d copy -f hls -hls_time 2`);
  }
  writeFileSync(join(d, 'master.m3u8'), ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-STREAM-INF:BANDWIDTH=3300000,RESOLUTION=1280x720,CODECS="avc1.640020"', 'hi/index.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e"', 'lo/index.m3u8', ''].join('\n'));
  record(d, 'hand-written master playlist');
  writeFileSync(
    join(DATA, 'SOURCES.json'),
    JSON.stringify(
      {
        group: 'streams (2.5)',
        note: 'Nothing here was downloaded: every file is derived with FFmpeg 9.0.2 (gw-te environment) from the T&E corpus file D:/TE-corpus/derived-fmv-variants/truck_mpeg2_klv.ts (SCN-30; Esri FMV tutorial data, test-only per OD-09) or from the repository fixture fixtures/fx10/fx10.ts.',
        sources: [{ file: TRUCK2, sha256: '51c429f497acd006f225414c66faf396c8bd8d760dd77c2b06b7b8e82b5c1e5f', licence: 'Esri tutorial data, no explicit licence: test-only (OD-09)' }, { file: 'fixtures/fx10/fx10.ts', licence: 'own synthetic (Apache-2.0)' }],
        files,
      },
      null,
      1,
    ),
  );
}
console.log(`${files.length} files`);
