#!/usr/bin/env node
// S-49 (SDP-2.1 §8): MPEG-2 → H.264 with every KLV packet kept and its timing, and the H.264 encoder
// licence route. For each corpus MPEG-2 file: transcode with the sidecar's video-h264-klv profile,
// then with the gw-te ffprobe (an independent build) compare the data streams packet by packet
// (count, SHA-256 of each payload, PTS/DTS), and parse both KLV streams with klvdata.
//   node sidecar/spikes/s49-klv.mjs
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { withSidecar, te, tePy, report, CORPUS } from './common.mjs';

const FILES = [
  ['derived-fmv-variants/truck_mpeg2_klv.ts', 'mpegts'],
  ['derived-fmv-variants/dayflight_mpeg2_klv.ts', 'mpegts'],
  ['derived-fmv-variants/nightir_mpeg2_klv.ts', 'mpegts'],
  ['fmv-esri-multiplexer-tutorial/FMV_Multiplexer_Tutorial/Raw_Video.mpeg', 'mpeg'],
];

function dataPackets(path) {
  const j = JSON.parse(te('ffprobe.exe', ['-v', 'error', '-select_streams', 'd', '-show_packets', '-show_data_hash', 'SHA256', '-of', 'json', path]));
  return (j.packets ?? []).map((p) => ({ stream: p.stream_index, pts: p.pts, dts: p.dts, size: Number(p.size), hash: p.data_hash }));
}
function streams(path) {
  return JSON.parse(te('ffprobe.exe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]));
}
const KLV_PY = `
import sys, klvdata
data = open(sys.argv[1], 'rb').read()
n = 0; uas = 0; keys = set()
for p in klvdata.StreamParser(data):
    n += 1
    k = getattr(p, 'key', b'')
    keys.add(bytes(k).hex() if isinstance(k, (bytes, bytearray)) else str(k))
    if type(p).__name__ == 'UASLocalMetadataSet': uas += 1
print(n, uas, len(keys))
`;

await withSidecar('s49', async ({ upload, run, outPath, s }) => {
  const rows = [];
  for (const [rel, container] of FILES) {
    const src = join(CORPUS, rel);
    const up = await upload(src);
    const t0 = Date.now();
    const job = await run('video-h264-klv', [up.id], { container });
    const row = { file: rel, state: job.state, error: job.error, ms: Date.now() - t0 };
    if (job.state === 'succeeded') {
      const out = outPath(job);
      const a = dataPackets(src);
      const b = dataPackets(out);
      const so = streams(out);
      row.output = job.outputs[0].name;
      row.video_codec = so.streams.find((x) => x.codec_type === 'video')?.codec_name;
      row.encoder = job.provenance.options.encoder;
      row.klv_in = a.length;
      row.klv_out = b.length;
      row.payload_identical = a.length === b.length && a.every((p, i) => p.hash === b[i].hash && p.size === b[i].size);
      row.timing_identical = a.length === b.length && a.every((p, i) => p.pts === b[i].pts && p.dts === b[i].dts);
      const firstDiff = a.findIndex((p, i) => !b[i] || p.pts !== b[i].pts);
      row.first_timing_diff = firstDiff < 0 ? null : { i: firstDiff, in: a[firstDiff]?.pts, out: b[firstDiff]?.pts };
      row.duration_in = Number(streams(src).format.duration);
      row.duration_out = Number(so.format.duration);
      if (a.length) {
        const dir = join(s.dataDir, 'klv');
        mkdirSync(dir, { recursive: true });
        const ex = (f, o) => execFileSync('E:/gwb-sidecar-deps/ffmpeg-26/bin/ffmpeg.exe', ['-v', 'error', '-y', '-i', f, '-map', '0:d:0', '-c', 'copy', '-f', 'data', o]);
        ex(src, join(dir, 'in.klv'));
        ex(out, join(dir, 'out.klv'));
        row.klvdata_in = tePy(KLV_PY, [join(dir, 'in.klv')]).trim();
        row.klvdata_out = tePy(KLV_PY, [join(dir, 'out.klv')]).trim();
      }
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  const pass = rows.every((r) => r.state === 'succeeded' && r.video_codec === 'h264' && r.payload_identical && r.timing_identical && r.klvdata_in === r.klvdata_out);
  report('s49-klv', {
    spike: 'S-49',
    verdict: pass ? 'pass' : 'fail',
    encoder_route: 'h264_mf (Windows Media Foundation H.264 encoder, licensed with Windows). The Media module’s FFmpeg has no OpenH264 (OD-2.30): Cisco’s patent licence covers only its own binaries, downloaded separately, so libopenh264 is not offered on Windows.',
    rows,
  });
  console.log(`S-49 ${pass ? 'PASS' : 'FAIL'}`);
});
