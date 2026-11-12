// 2.5 streams (gap wave T0b, SCN-55): REQ-GAP-49 HLS with MISB KLV through fetch and Media Source
// Extensions, against a local HLS server (tests/tools/hls-server.mjs): on-demand and live sliding
// playlists, a discontinuity, AES-128, synchronous KLV (the server's own segmenter keeps stream
// type 0x15) and asynchronous KLV (FFmpeg's HLS muxer), KLV sync measured per presented frame
// against the fx10 truth and against the file player, live latency measured from the server's
// publication to the first presented frame, MPEG-2 through the app's decoder (SCN-30 corpus),
// and the refusals by name. REQ-GAP-64 ArcGIS portals against a mock portal and hosting server
// (tests/e2e/portal-mock.js): guest search, sign-in with PKCE and the out-of-band code from a
// file opened from disk, the token only in X-Esri-Authorization and only to the portal and the
// server the user confirmed, items and web maps, attachments, related records with the typed
// checks, branch versions (read, edit, save, reconcile and post), and a .lyrx style.
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { openApp } from './helpers.js';
import { startHls, segmentTs } from '../tools/hls-server.mjs';
import { mockPortal } from './portal-mock.js';
import { mockServices } from './svc-mock.js';

test.describe.configure({ timeout: 240_000 });

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const FX10 = resolve('fixtures', 'fx10', 'fx10.ts');
const TRUTH = JSON.parse(readFileSync(resolve('fixtures', 'fx10', 'fx10_truth.json'), 'utf8'));
const FXS = resolve('fixtures', 'fx25', 'streams');
const DATA = process.env.GW_STREAMS_DATA ?? 'E:/gwb25/data-streams';
const TRUCK_TS = 'E:/TE-corpus/fmv-esri-truck-tutorial/FMV tutorial data/Truck.ts';

let hls;
let portal;
let svc;
let po; // portal origins
let svcOrigin;
const made = [];
test.beforeAll(async () => {
  hls = await startHls();
  svc = mockServices();
  svcOrigin = await svc.start();
  portal = mockPortal();
  po = await portal.start({ svcOrigin });
});
test.afterAll(async () => {
  await hls?.close();
  await portal?.close();
  await svc?.close();
  made.forEach((p) => rmSync(p, { force: true }));
});

/** A copy of the built file whose network allow-list holds `origins` (add → save → reload, REQ-ARC-16). */
async function allowed(page, origins) {
  const { frame } = await openApp(page, 'file');
  const html = await frame.evaluate((o) => window.gisworkbench.__test.htmlWithOrigins(o), origins);
  const dir = join(tmpdir(), 'gw-25-streams');
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, `gw-streams-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.html`);
  writeFileSync(copy, html);
  made.push(copy);
  const page2 = await page.context().newPage();
  const r = await openApp(page2, 'file', { htmlPath: copy });
  return { page2, ...r };
}
const quiet = (logs) => logs.filter((l) => !/ERR_CONNECTION_REFUSED|127\.0\.0\.1:4782|status of 404|status of 499/.test(l));

async function axe(frame, sel) {
  if (!(await frame.evaluate(() => !!window.axe))) await frame.evaluate(AXE);
  return frame.evaluate(async (s) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), sel);
}

/**
 * Play the active video panel for `seconds` and record every presented frame: its media time, the
 * clip frame it maps to, that frame's segment and position in it, and the KLV state's precision
 * time and source packet time. In the page.
 */
async function playAndRecord(frame, seconds, { seek = null } = {}) {
  return frame.evaluate(
    async ([secs, seekTo]) => {
      const app = window.gisworkbench;
      const v = app.activePane().video;
      const el = v.video;
      const clip = v.clip;
      if (seekTo !== null) {
        v.seekFrame(seekTo);
        await new Promise((r) => setTimeout(r, 600));
      }
      v.play();
      const rows = [];
      const edge = [];
      const firstOfSeq = new Map();
      await new Promise((res) => {
        const end = performance.now() + secs * 1000;
        const tick = setInterval(() => {
          const s = clip.stream;
          if (s) edge.push((s.order.at(-1)?.t1 ?? 0) - el.currentTime);
        }, 1000);
        const cb = (now, meta) => {
          const i = app.fmv.frameAt(clip, meta.mediaTime);
          const f = clip.frames[i];
          const st = app.fmv.stateAt(clip, i);
          if (f.seq !== undefined && !firstOfSeq.has(f.seq)) firstOfSeq.set(f.seq, clip.frames.findIndex((x) => x.seq === f.seq));
          rows.push({ mt: meta.mediaTime, i, ft: f.t, seq: f.seq ?? null, inSeg: f.seq !== undefined ? i - firstOfSeq.get(f.seq) : i, time: st?.time ?? null, kt: st?.packet?.tMux ?? null, interp: !!st?.interpolated, stale: !!st?.stale, fp: !!st?.footprint, at: Date.now() });
          if (performance.now() < end) el.requestVideoFrameCallback(cb);
          else {
            clearInterval(tick);
            res();
          }
        };
        el.requestVideoFrameCallback(cb);
      });
      v.pause();
      return { rows, edge, firstState: clip.states[0]?.t ?? null, fps: clip.fps, frames: clip.frames.length, packets: clip.packets.length, dropped: el.getVideoPlaybackQuality?.().droppedVideoFrames ?? null };
    },
    [seconds, seek],
  );
}

/** KLV sync of recorded rows against the fx10 truth (frame k ↔ precision time), in ms; `kOf(row)` gives the truth frame. */
function syncStats(rows, kOf) {
  const err = rows.filter((r) => r.time !== null).map((r) => (r.time - TRUTH.frames[kOf(r) % 300].precision_time_us) / 1000);
  const abs = err.map(Math.abs).sort((a, b) => a - b);
  const mapErr = rows.map((r) => Math.abs(r.mt - r.ft)); // the media time inside the frame it maps to
  return { n: err.length, maxMs: abs.at(-1) ?? null, p95Ms: abs[Math.floor(abs.length * 0.95)] ?? null, medianMs: abs[abs.length >> 1] ?? null, maxMapS: Math.max(...mapErr) };
}

// ---------------------------------------------------------------- REQ-GAP-49 HLS

test('REQ-GAP-49 SCN-55 on-demand HLS with synchronous KLV: every presented frame carries its own packet, as in the file player', async ({ page }) => {
  const segs = segmentTs(readFileSync(FX10), 2);
  const { url } = hls.vodSegments('fx10sync', segs);
  const fileUrl = hls.file('/fx10.ts', readFileSync(FX10), 'video/mp2t');
  const { page2, frame, logs } = await allowed(page, [hls.origin]);
  const open = await frame.evaluate(async (u) => {
    const app = window.gisworkbench;
    const s = await app.streams.open(u);
    for (let k = 0; k < 100 && !s.ended; k++) await new Promise((r) => setTimeout(r, 100));
    const c = s.clip;
    return { ...s.summary(), codec: c.codec, w: c.width, h: c.height, fps: c.fps, sync: c.packets.every((k) => k.sync), states: c.states.length, kind: app.activePane().video.metadataOnly };
  }, url);
  expect(open).toMatchObject({ live: false, ended: true, segments: segs.length, frames: 300, packets: 300, codec: 'avc1.64001E', w: 640, h: 360, fps: 30, sync: true, states: 300, kind: false, missed: 0, failed: 0 });
  const hlsRun = await playAndRecord(frame, 4, { seek: 0 });
  const st = syncStats(hlsRun.rows, (r) => r.i);
  // Synchronous KLV: the state of each frame is its own packet, exactly (no interpolation).
  expect(st.n).toBeGreaterThan(90);
  expect(st.maxMs).toBe(0);
  expect(hlsRun.rows.every((r) => Math.abs(r.kt - r.ft) < 1e-9 && !r.interp && !r.stale && r.fp)).toBe(true);
  expect(st.maxMapS).toBeLessThan(0.5 / 30);
  // The same stream as a file, through the file player (the baseline).
  const fileRun = await frame.evaluate(async (u) => {
    const app = window.gisworkbench;
    const b = await (await fetch(u)).arrayBuffer();
    await app.fmv.closeVideo();
    await app.openMotionFiles({ video: [new File([b], 'fx10.ts')] }, app.activePane());
    return app.activePane().video.clip.frames.length;
  }, fileUrl);
  expect(fileRun).toBe(300);
  const base = await playAndRecord(frame, 4, { seek: 0 });
  const bs = syncStats(base.rows, (r) => r.i);
  expect(bs.maxMs).toBe(0);
  test.info().annotations.push({ type: 'measure', description: JSON.stringify({ hls: { ...st, presented: hlsRun.rows.length, dropped: hlsRun.dropped, appendMs: open.appendMs, indexMs: open.indexMs }, file: { ...bs, presented: base.rows.length } }) });
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});

test('REQ-GAP-49 AES-128 on-demand HLS from FFmpeg, and asynchronous KLV (no PTS) through the segmenter: KLV within one frame of the truth', async ({ page }) => {
  hls.vod('fx10aes', join(FXS, 'fx10-aes'));
  const url = `${hls.origin}/fx10aes/index.m3u8`;
  const { page2, frame, logs } = await allowed(page, [hls.origin]);
  const open = await frame.evaluate(async (u) => {
    const app = window.gisworkbench;
    const s = await app.streams.open(u);
    for (let k = 0; k < 100 && !s.ended; k++) await new Promise((r) => setTimeout(r, 100));
    return { ...s.summary(), sync: s.clip.packets.filter((k) => k.sync).length };
  }, url);
  // FFmpeg's muxer writes the KLV PES with stream_id 0xFC (metadata), read as synchronous, with a PTS.
  expect(open).toMatchObject({ ended: true, segments: 5, decrypted: 5, frames: 300, packets: 300 });
  // The key was fetched once, from the allowed origin.
  expect(hls.seen.filter((x) => x.path === '/fx10aes/key.bin')).toHaveLength(1);
  const run = await playAndRecord(frame, 4, { seek: 0 });
  const st = syncStats(run.rows, (r) => r.i);
  expect(st.n).toBeGreaterThan(90);
  expect(st.maxMs).toBeLessThanOrEqual(1000 / 30 + 1e-6);
  // fx10_b.ts: asynchronous KLV (0x06 KLVA, PES 0xBD, no PTS), placed by its Precision Time Stamps.
  const b = hls.vodSegments('fx10async', segmentTs(readFileSync(resolve('fixtures', 'fx10', 'fx10_b.ts')), 2));
  const ob = await frame.evaluate(async (u) => {
    const app = window.gisworkbench;
    await app.fmv.closeVideo();
    const s = await app.streams.open(u);
    for (let k = 0; k < 100 && !s.ended; k++) await new Promise((r) => setTimeout(r, 100));
    return { ...s.summary(), sync: s.clip.packets.filter((k) => k.sync).length, bad: s.clip.packets.filter((k) => !k.ok).length };
  }, b.url);
  expect(ob).toMatchObject({ ended: true, frames: 300, sync: 0, bad: 2 });
  const runB = await playAndRecord(frame, 4, { seek: 0 });
  const sb = syncStats(runB.rows, (r) => r.i);
  expect(sb.n).toBeGreaterThan(90);
  expect(sb.maxMs).toBeLessThanOrEqual(1000 / 30 + 1e-6);
  test.info().annotations.push({ type: 'measure', description: JSON.stringify({ ffmpegAes: { ...st, syncPackets: open.sync }, asyncNoPts: sb }) });
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});

test('REQ-GAP-49 live sliding window with AES-128 and a discontinuity at each loop: latency measured, KLV in sync after the discontinuity', async ({ page }) => {
  const segs = segmentTs(readFileSync(FX10), 1); // 10 segments of 30 frames
  expect(segs.every((s) => Math.abs(s.duration - 1) < 1e-6)).toBe(true);
  const live = hls.live('fx10live', segs, { window: 4, aes: true, loops: 3, startAhead: 4, targetDuration: 1 });
  const { page2, frame, logs } = await allowed(page, [hls.origin]);
  const open = await frame.evaluate(async (u) => {
    const app = window.gisworkbench;
    const s = await app.streams.open(u);
    window.__s = s;
    return s.summary();
  }, live.url);
  expect(open.live).toBe(true);
  // Live: the player starts three target durations from the end (RFC 8216 §6.3.3).
  const run = await playAndRecord(frame, 16);
  const sum = await frame.evaluate(() => window.__s.summary());
  // The truth frame of a presented frame: its segment's place in the loop and its place in the segment.
  const kOf = (r) => (r.seq % 10) * 30 + r.inSeg;
  const st = syncStats(run.rows, kOf);
  expect(sum.missed).toBe(0);
  expect(sum.failed).toBe(0);
  expect(sum.discontinuities).toBeGreaterThanOrEqual(1);
  // Every placed segment was decrypted (one more may be in the decode worker when the summary is read).
  expect(sum.decrypted - sum.segments).toBeGreaterThanOrEqual(0);
  expect(sum.decrypted - sum.segments).toBeLessThanOrEqual(1);
  // Across the discontinuity the presented frames go on 1/30 s apart, and KLV stays exact.
  const after = run.rows.filter((r) => r.seq >= 10);
  expect(after.length).toBeGreaterThan(30);
  expect(st.maxMs).toBe(0);
  const gaps = run.rows.slice(1).map((r, i) => r.mt - run.rows[i].mt).filter((g) => g > 0);
  expect(Math.max(...gaps)).toBeLessThan(0.2);
  // Latency: server publication → first presented frame of each segment (same machine clock).
  const lat = sum.latency.filter((x) => live.state.published.has(x.seq)).map((x) => x.shownAt - live.state.published.get(x.seq)).sort((a, b) => a - b);
  expect(lat.length).toBeGreaterThan(8);
  const edge = run.edge.slice(3).sort((a, b) => a - b);
  test.info().annotations.push({ type: 'measure', description: JSON.stringify({ live: { sync: st, latencyMs: { min: lat[0], median: lat[lat.length >> 1], max: lat.at(-1), n: lat.length }, behindEdgeS: { median: edge[edge.length >> 1], max: edge.at(-1) }, reloads: sum.reloads, segments: sum.segments, dropped: run.dropped } }) });
  // Three target durations of hold-back plus fetch and decode: well under 6 s here.
  expect(lat[lat.length >> 1]).toBeLessThan(6000);
  expect(quiet(logs)).toEqual([]);
  await frame.evaluate(() => window.gisworkbench.fmv.closeVideo());
  await page2.close();
});

test('REQ-GAP-49 SCN-30 corpus: H.264 master playlist (variant choice) and MPEG-2 through the app’s own decoder', async ({ page }) => {
  test.skip(!existsSync(join(DATA, 'truck-h264-hls', 'master.m3u8')) || !existsSync(join(DATA, 'truck-mpeg2-hls', 'index.m3u8')), 'run build/fixtures/fx25-streams.mjs (needs the T&E corpus on E:)');
  hls.vod('truck', join(DATA, 'truck-h264-hls'));
  hls.vod('truck/hi', join(DATA, 'truck-h264-hls', 'hi'));
  hls.vod('truck/lo', join(DATA, 'truck-h264-hls', 'lo'));
  hls.vod('truck2', join(DATA, 'truck-mpeg2-hls'));
  const { page2, frame, logs } = await allowed(page, [hls.origin]);
  const r = await frame.evaluate(async ([m, m2]) => {
    const app = window.gisworkbench;
    const wait = async (s) => {
      for (let k = 0; k < 600 && !s.ended; k++) await new Promise((res) => setTimeout(res, 100));
    };
    const out = {};
    const lo = await app.streams.open(m, { maxBandwidth: 1e6 });
    out.lo = { variant: lo.summary().variant, w: lo.clip.width };
    await app.fmv.closeVideo();
    const t0 = performance.now();
    const hi = await app.streams.open(m);
    out.firstFrameMs = Math.round(performance.now() - t0);
    await wait(hi);
    const c = hi.clip;
    out.hi = { ...hi.summary(), w: c.width, h: c.height, states: c.states.length, footprints: [0, 300, 900].map((i) => !!app.fmv.stateAt(c, i)?.footprint) };
    await app.fmv.closeVideo();
    const t1 = performance.now();
    const s2 = await app.streams.open(m2);
    out.mpeg2 = { mpeg2: s2.mpeg2, codec: s2.clip.codec, frames: s2.clip.frames.length, packets: s2.clip.packets.length, native: !!app.activePane().video.media, ms: Math.round(performance.now() - t1) };
    return out;
  }, [`${hls.origin}/truck/master.m3u8`, `${hls.origin}/truck2/index.m3u8`]);
  expect(r.lo.variant.resolution).toEqual([640, 360]);
  expect(r.lo.w).toBe(640);
  expect(r.hi).toMatchObject({ w: 1280, h: 720, ended: true, failed: 0 });
  expect(r.hi.frames).toBeGreaterThan(1700);
  expect(r.hi.packets).toBeGreaterThan(250);
  expect(r.hi.footprints).toEqual([true, true, true]);
  expect(r.mpeg2).toMatchObject({ mpeg2: true, codec: 'mp2v', native: true });
  expect(r.mpeg2.frames).toBe(1799);
  expect(r.mpeg2.packets).toBe(288);
  const run = await playAndRecord(frame, 3, { seek: 0 });
  expect(run.rows.length).toBeGreaterThan(60);
  test.info().annotations.push({ type: 'measure', description: JSON.stringify({ corpus: { firstFrameMs: r.firstFrameMs, hiSegments: r.hi.segments, indexMs: r.hi.indexMs, mpeg2OpenMs: r.mpeg2.ms, mpeg2Presented3s: run.rows.length } }) });
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});

test('REQ-GAP-49 Truck.ts (synchronous KLV, 1080p) as a live stream cut by the test segmenter', async ({ page }) => {
  test.skip(!existsSync(TRUCK_TS), 'the T&E corpus is not on E:');
  const segs = segmentTs(readFileSync(TRUCK_TS).subarray(0, 188 * 100000), 2).slice(0, -1);
  const live = hls.live('trucklive', segs, { window: 5, loops: 1, startAhead: 4 });
  const { page2, frame, logs } = await allowed(page, [hls.origin]);
  await frame.evaluate(async (u) => {
    window.__t = await window.gisworkbench.streams.open(u);
  }, live.url);
  const run = await playAndRecord(frame, 8);
  const sum = await frame.evaluate(() => ({ ...window.__t.summary(), sync: window.__t.clip.packets.filter((k) => k.sync).length }));
  expect(sum.sync).toBeGreaterThan(0);
  expect(sum.failed).toBe(0);
  // Synchronous KLV on its frame where the frame has a packet; elsewhere the previous one (Truck.ts reports on change).
  const exact = run.rows.filter((r) => r.kt !== null && Math.abs(r.kt - r.ft) < 1e-9).length;
  // Frames before the first KLV packet take that first packet, as in the file player.
  const lag = run.rows.filter((r) => r.kt !== null && r.ft >= run.firstState).map((r) => r.ft - r.kt).sort((a, b) => a - b);
  test.info().annotations.push({ type: 'measure', description: JSON.stringify({ truckLive: { presented: run.rows.length, exactKlvFrames: exact, klvAgeS: { min: lag[0], median: lag[lag.length >> 1], max: lag.at(-1) }, stale: run.rows.filter((r) => r.stale).length, segments: sum.segments, dropped: run.dropped } }) });
  expect(run.rows.length).toBeGreaterThan(150);
  expect(lag.length).toBeGreaterThan(150);
  expect(lag[0]).toBeGreaterThanOrEqual(-1e-6); // never a packet from the future
  expect(quiet(logs)).toEqual([]);
  await frame.evaluate(() => window.gisworkbench.fmv.closeVideo());
  await page2.close();
});

test('REQ-GAP-49 refusals by name: origin not allowed (no request), fMP4, SAMPLE-AES, unreachable key, live MPEG-2, H.265', async ({ page }) => {
  const seg = segmentTs(readFileSync(FX10), 2)[0].bytes;
  const hevc = Buffer.from(seg);
  for (let o = 0; o < hevc.length; o += 188) if ((((hevc[o + 1] & 0x1f) << 8) | hevc[o + 2]) === 4096) for (let q = o + 5; q < o + 185; q++) if (hevc[q] === 0x1b && hevc[q + 1] === 0xe1 && hevc[q + 2] === 0x00) hevc[q] = 0x24;
  const pl = (body) => `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n${body}`;
  const u = {
    fmp4: hls.file('/r/fmp4.m3u8', pl('#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\na.m4s\n#EXT-X-ENDLIST\n')),
    sample: hls.file('/r/sample.m3u8', pl('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n')),
    nokey: hls.file('/r/nokey.m3u8', pl('#EXT-X-KEY:METHOD=AES-128,URI="missing.bin"\n#EXTINF:2,\nseg.ts\n#EXT-X-ENDLIST\n')),
    skd: hls.file('/r/skd.m3u8', pl('#EXT-X-KEY:METHOD=AES-128,URI="skd://key"\n#EXTINF:2,\nseg.ts\n#EXT-X-ENDLIST\n')),
    hevc: hls.file('/r/hevc.m3u8', pl('#EXTINF:2,\nhevc.ts\n#EXT-X-ENDLIST\n')),
  };
  hls.file('/r/seg.ts', Buffer.alloc(16 * 100), 'video/mp2t');
  hls.file('/r/hevc.ts', hevc, 'video/mp2t');
  if (existsSync(join(DATA, 'truck-mpeg2-hls', 'seg000.ts'))) {
    hls.file('/r/m2.ts', readFileSync(join(DATA, 'truck-mpeg2-hls', 'seg000.ts')), 'video/mp2t');
    u.m2live = hls.file('/r/m2live.m3u8', pl('#EXTINF:4,\nm2.ts\n'));
  }
  // An app copy that allows the server; then one that does not.
  const { page2, frame } = await allowed(page, [hls.origin]);
  const codes = await frame.evaluate(async (urls) => {
    const out = {};
    for (const [k, v] of Object.entries(urls)) {
      try {
        await window.gisworkbench.streams.open(v);
        out[k] = 'opened';
      } catch (e) {
        out[k] = e.code;
      }
    }
    return out;
  }, u);
  expect(codes).toMatchObject({ fmp4: 'E_HLS_FMP4', sample: 'E_HLS_SAMPLE_AES', nokey: 'E_HLS_KEY_UNREACHABLE', skd: 'E_HLS_KEY_UNREACHABLE', hevc: 'E_HLS_CODEC' });
  if (u.m2live) expect(codes.m2live).toBe('E_HLS_MPEG2_LIVE');
  // The dialog passes axe.
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('fmv.hls');
  });
  await frame.waitForSelector('[data-id="dialog:hls-open"]');
  expect(await axe(frame, '[data-id="dialog:hls-open"]')).toEqual([]);
  await frame.click('[data-id="dialog:hls-open"] .dlg-x');
  await page2.close();
  const { frame: f2 } = await openApp(page, 'file');
  const before = hls.seen.length;
  const r = await f2.evaluate(async (v) => {
    try {
      await window.gisworkbench.streams.open(v);
      return 'opened';
    } catch (e) {
      return { code: e.code, logged: window.gisworkbench.netlog.entries.at(-1)?.status };
    }
  }, `${hls.origin}/fx10sync/index.m3u8`);
  expect(r).toEqual({ code: 'E_NET_NOT_ALLOWED', logged: 'not allowed' });
  expect(hls.seen.length).toBe(before);
});

// ---------------------------------------------------------------- REQ-GAP-64 ArcGIS portals

test('REQ-GAP-64 portal as a guest: search sees public items only; a map service and a web map open, the rest is refused by name', async ({ page }) => {
  const { page2, frame, logs } = await allowed(page, [po.portal, po.host, svcOrigin]);
  const r = await frame.evaluate(async (root) => {
    const app = window.gisworkbench;
    const out = {};
    out.connect = await app.portal.connect(root);
    const s = await app.portal.search(root, { q: '' });
    out.found = s.results.map((x) => [x.title, x.kind]);
    out.map = await app.portal.openItem(root, 'cc33cc33cc33cc33cc33cc33cc33cc33');
    try {
      await app.portal.openItem(root, 'dd44dd44dd44dd44dd44dd44dd44dd44');
    } catch (e) {
      out.pdf = e.code;
    }
    const wm = await app.portal.openItem(root, 'bb22bb22bb22bb22bb22bb22bb22bb22');
    out.webmap = { layers: wm.layers.length, services: wm.services.length, refused: wm.refused.map((x) => [x.title, x.reason.slice(0, 40)]), basemap: wm.basemap };
    return out;
  }, po.portal);
  expect(r.connect).toMatchObject({ name: 'Mock Portal', user: null });
  expect(r.found).toEqual([['Operations map', 'webmap'], ['Base map service', 'map'], ['Field manual', null]]);
  expect(r.map.services).toHaveLength(1);
  expect(r.pdf).toBe('E_PORTAL_ITEM_TYPE');
  // As a guest the secured feature layer is refused by name (token required); the collection and the map service open.
  expect(r.webmap.layers).toBe(1);
  expect(r.webmap.services).toBe(1);
  expect(r.webmap.refused.map((x) => x[0])).toEqual(['Field / Units', 'Spreadsheet', 'Overlay']);
  expect(r.webmap.refused[0][1]).toMatch(/Token Required/);
  expect(r.webmap.basemap).toEqual(['World Topographic Map']);
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});

test('REQ-GAP-64 sign-in from a file with PKCE and the out-of-band code; the token goes only in X-Esri-Authorization to the portal and the confirmed server', async ({ page }) => {
  const { page2, frame, logs } = await allowed(page, [po.portal, po.host, svcOrigin]);
  await frame.evaluate(AXE);
  const popupP = page2.waitForEvent('popup');
  const signed = frame.evaluate(async (root) => window.gisworkbench.portal.signIn(root, { clientId: 'gw-test-client' }), po.portal);
  await frame.waitForSelector('[data-id="dialog:signin-pkce"]');
  expect(await axe(frame, '[data-id="dialog:signin-pkce"]')).toEqual([]);
  const popup = await popupP;
  await popup.waitForSelector('#code');
  const code = await popup.textContent('#code');
  await popup.close();
  await frame.fill('[data-id="signin:paste"]', code);
  await frame.click('[data-id="dialog:signin-pkce"] .btn-primary');
  expect(await signed).toBe(true);
  const auth = portal.seen.find((x) => x.path === '/sharing/rest/oauth2/authorize');
  const q = new URLSearchParams(auth.query);
  expect(q.get('redirect_uri')).toBe('urn:ietf:wg:oauth:2.0:oob');
  expect(q.get('code_challenge_method')).toBe('S256');
  expect(q.has('code_verifier')).toBe(false);
  // Search now sees the organisation's secured item; opening it asks whether the sign-in goes to the hosting server.
  const p1 = frame.evaluate(async (root) => {
    const app = window.gisworkbench;
    const s = await app.portal.search(root, { q: 'units' });
    const o = await app.portal.openItem(root, s.results[0]);
    return { found: s.results.map((x) => x.title), layers: o.layers.length, user: (await app.portal.connect(root)).user };
  }, po.portal);
  await frame.waitForSelector('[data-id="dialog:portal-trust"]');
  expect(await axe(frame, '[data-id="dialog:portal-trust"]')).toEqual([]);
  await frame.click('[data-id="dialog:portal-trust"] .btn-primary');
  const r = await p1;
  expect(r).toEqual({ found: ['Units (secured)'], layers: 1, user: 'editor1' });
  // Every host request carried the header; no token in any URL anywhere.
  const issued = [...portal.state.tokens.keys(), ...portal.state.refresh.keys()];
  const mine = issued.filter((tk) => !tk.startsWith('at-test-')); // signedIn() of other tests injects its own
  const hostReqs = portal.seen.filter((x) => x.server === 'host' && mine.includes(x.token));
  expect(hostReqs.length).toBeGreaterThan(2);
  expect(hostReqs.every((x) => x.header === 'x-esri' && !x.query.includes('token='))).toBe(true);
  for (const x of portal.seen) for (const tk of issued) expect(x.query.includes(tk), x.path).toBe(false);
  const leaks = await frame.evaluate(() => {
    const app = window.gisworkbench;
    return [document.documentElement.outerHTML, JSON.stringify(app.netlog.entries), JSON.stringify(app.store.snapshot()), JSON.stringify(app.auth), JSON.stringify(app.prefs.user('signInOrigins'))].join('\n');
  });
  for (const tk of issued) expect(leaks.includes(tk)).toBe(false);
  const entry = await frame.evaluate((o) => window.gisworkbench.auth.policy.get(o).oidc, po.portal);
  expect(entry).toMatchObject({ kind: 'arcgis', header: 'X-Esri-Authorization', alsoFor: [po.host] });
  // Sign-out revokes the refresh token (ArcGIS auth_token).
  await frame.evaluate((o) => window.gisworkbench.auth.signOut(o), po.portal);
  expect(portal.state.revoked.at(-1).auth_token).toMatch(/^rt-/);
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});

/** A signed-in app copy with the Units layer open (token injected as a sign-in would leave it). */
async function signedIn(page) {
  const r = await allowed(page, [po.portal, po.host, svcOrigin]);
  const access = 'at-test-' + Math.random().toString(16).slice(2);
  portal.state.tokens.set(access, { user: 'editor1', exp: Date.now() + 1800e3 });
  await r.frame.evaluate(
    async ([root, host, tok]) => {
      const app = window.gisworkbench;
      const { arcgisMeta } = { arcgisMeta: (x) => ({ issuer: x, token_endpoint: `${x}/sharing/rest/oauth2/token`, authorization_endpoint: `${x}/sharing/rest/oauth2/authorize`, oob: true }) };
      app.auth.policy.set({ origin: root, oidc: { issuer: root, clientId: 'gw-test-client', kind: 'arcgis', grant: 'pkce', alsoFor: [host] } });
      app.auth.vault.set(root, { access_token: tok, expires_in: 1800 }, { meta: arcgisMeta(root), clientId: 'gw-test-client' });
      await app.portal.openItem(root, 'aa11aa11aa11aa11aa11aa11aa11aa11');
    },
    [po.portal, po.host, access],
  );
  return r;
}

test('REQ-GAP-64 attachments and related records of a feature: listed, added, deleted; related edits checked against the table first', async ({ page }) => {
  const { page2, frame, logs } = await signedIn(page);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const S = app.store;
    const units = S.all('vlayer').find((v) => /Units$/.test(v.name));
    const f1 = S.all('feature').find((f) => f.vlayer === units.id && f.remoteId === 1);
    app.selection = new Set([f1.id]);
    const out = {};
    out.list0 = (await app.portal.attachments()).map((a) => [a.id, a.name, a.size]);
    const blob = await app.portal.attachmentBlob((await app.portal.attachments())[0]);
    out.blob = [...new Uint8Array(await blob.arrayBuffer())];
    const add = await app.portal.addAttachment(f1.id, new File([new TextEncoder().encode('report text')], 'report.txt', { type: 'text/plain' }));
    out.added = add.id;
    out.list1 = (await app.portal.attachments()).map((a) => a.name);
    out.deleted = await app.portal.deleteAttachments(f1.id, [11]);
    out.list2 = (await app.portal.attachments()).map((a) => a.name);
    const rel = await app.portal.related(f1.id);
    out.rel = rel.map((g) => ({ name: g.rel.name, n: g.records.length, results: g.records.map((x) => x.RESULT), date: g.records[0].INSPECTED }));
    try {
      await app.portal.saveRelated(f1.id, 0, { adds: [{ RESULT: 'maybe', SCORE: 12, NOTE: 'x'.repeat(30) }] });
    } catch (e) {
      out.refused = { code: e.code, codes: e.issues.map((x) => x.code) };
    }
    out.saved = await app.portal.saveRelated(f1.id, 0, { adds: [{ RESULT: 'pass', SCORE: '9', INSPECTED: '2024-07-01T00:00:00.000Z', NOTE: 'new' }], updates: [{ OBJECTID: 2, SCORE: 5 }] });
    out.after = (await app.portal.related(f1.id))[0].records.map((x) => [x.OBJECTID, x.SCORE]);
    return out;
  });
  expect(r.list0).toEqual([[11, 'photo.jpg', 4]]);
  expect(r.blob).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  expect(r.list1).toEqual(['photo.jpg', 'report.txt']);
  expect(r.deleted).toEqual([11]);
  expect(r.list2).toEqual(['report.txt']);
  expect(r.rel).toEqual([{ name: 'Unit_Inspections', n: 2, results: ['pass', 'fail'], date: '2024-01-05T00:00:00.000Z' }]);
  expect(r.refused).toEqual({ code: 'E_ATTRS_INVALID', codes: ['E_ATTR_DOMAIN', 'E_ATTR_RANGE', 'E_ATTR_LENGTH'] });
  expect(r.saved.addIds).toHaveLength(1);
  expect(r.after).toEqual([[1, 8], [2, 5], [r.saved.addIds[0], 9]]);
  // Only the valid edit reached the table, typed, with the parent's GlobalID as its key.
  const sent = portal.state.applyEdits.filter((x) => x.target === 'inspections');
  expect(sent).toHaveLength(1);
  expect(sent[0].adds[0].attributes).toEqual({ RESULT: 'pass', SCORE: 9, INSPECTED: Date.UTC(2024, 6, 1), NOTE: 'new', UNIT_GUID: '{G-1}' });
  expect(sent[0].updates[0].attributes).toEqual({ SCORE: 5, OBJECTID: 2 });
  // The dialogs pass axe.
  for (const [cmd, id] of [['vec.attachments', 'attachments'], ['vec.related', 'related']]) {
    await frame.evaluate((c) => {
      window.gisworkbench.commands.run(c);
    }, cmd);
    await frame.waitForSelector(`[data-id="dialog:${id}"]`);
    await frame.waitForTimeout(300);
    expect(await axe(frame, `[data-id="dialog:${id}"]`), id).toEqual([]);
    await frame.click(`[data-id="dialog:${id}"] .dlg-x`);
  }
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});

test('REQ-GAP-64 branch versions: list, edit a named version in a session, save, reconcile and post; the default version then has the edit', async ({ page }) => {
  const { page2, frame, logs } = await signedIn(page);
  const r = await frame.evaluate(async (guid) => {
    const app = window.gisworkbench;
    const S = app.store;
    const units = S.all('vlayer').find((v) => /Units$/.test(v.name));
    const out = {};
    out.list = (await app.portal.versions(units.id)).list.map((v) => [v.name, v.isDefault]);
    try {
      await app.portal.useVersion(units.id, (await app.portal.versions(units.id)).list[0].guid, { mode: 'edit' });
    } catch (e) {
      out.defaultEdit = e.code;
    }
    const vl = await app.portal.useVersion(units.id, guid, { mode: 'edit' });
    out.name = S.get(vl).name;
    out.gdbVersion = S.get(vl).source.gdbVersion;
    const f2 = S.all('feature').find((f) => f.vlayer === vl && f.remoteId === 2);
    S.transact('edit', (tx) => tx.set(f2.id, 'attrs', { ...f2.attrs, STRENGTH: 55 }));
    out.saved = await app.portal.saveVersion(vl);
    out.posted = await app.portal.reconcilePost(vl);
    // The default version, read as a guest of that version: STRENGTH 55 after the post.
    const dv = await app.remoteEdit.open({ kind: 'arcgis', url: S.get(vl).source.url, name: 'Units default' });
    out.defaultStrength = S.all('feature').find((f) => f.vlayer === dv && f.remoteId === 2).attrs.STRENGTH;
    app.prefs.set('vlayerActive', vl);
    return out;
  }, portal.guids.FIELDWORK);
  expect(r.list).toEqual([['sde.DEFAULT', true], ['editor1.fieldwork', false]]);
  expect(r.defaultEdit).toBe('E_ARCGIS_VERSION_DEFAULT');
  expect(r.name).toMatch(/\[editor1\.fieldwork\]$/);
  expect(r.gdbVersion).toBe('editor1.fieldwork');
  expect(r.saved).toMatchObject({ updates: 1 });
  expect(r.posted).toMatchObject({ hasConflicts: false, posted: true });
  expect(r.defaultStrength).toBe(55);
  const ops = portal.state.versionCalls.map((c) => c.op);
  expect(ops).toEqual(['startReading', 'startEditing', 'stopEditing', 'startEditing', 'reconcile', 'post']);
  const sid = portal.state.versionCalls[0].sessionId;
  expect(portal.state.versionCalls.every((c) => c.sessionId === sid)).toBe(true);
  expect(portal.state.versionCalls[2].saveEdits).toBe('true');
  const edit = portal.state.applyEdits.find((x) => x.target === 'units');
  expect(edit).toMatchObject({ gdbVersion: 'editor1.fieldwork', sessionID: sid });
  // The query of the version asked for it.
  expect(portal.seen.some((x) => x.path.endsWith('/0/query') && /gdbVersion=editor1\.fieldwork/.test(x.query))).toBe(true);
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('vec.versions');
  });
  await frame.waitForSelector('[data-id="dialog:versions"]');
  expect(await axe(frame, '[data-id="dialog:versions"]')).toEqual([]);
  await frame.click('[data-id="dialog:versions"] .dlg-x');
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});

test('REQ-GAP-64 a .lyrx unique-value style on the Units layer: rules per STATUS, labels, the unmapped parts named; the portal dialog passes axe', async ({ page }) => {
  const { page2, frame, logs } = await signedIn(page);
  const lyrx = readFileSync(join(FXS, 'lyrx', 'units-unique.lyrx'), 'utf8');
  const r = await frame.evaluate(async (text) => {
    const app = window.gisworkbench;
    const S = app.store;
    const units = S.all('vlayer').find((v) => /Units$/.test(v.name));
    const res = await app.portal.applyLyrx(units.id, new File([text], 'units-unique.lyrx'));
    const v = S.get(units.id);
    const fs = S.all('feature').filter((f) => f.vlayer === units.id).sort((a, b) => a.remoteId - b.remoteId);
    return { res, style: v.style, styles: fs.map((f) => app.attribution.ruleStyle(v, f)?.fill ?? null), undo: typeof app.undo === 'function' };
  }, lyrx);
  expect(r.res.layer).toBe('Units');
  expect(r.res.rules).toBe(3);
  expect(r.res.missing).toEqual([]);
  expect(r.res.refused.map((x) => x.reason)).toEqual(['extra stroke layer', 'symbol layer CIMHatchFill', 'definition query STRENGTH > 0']);
  expect(r.style).toMatchObject({ labelField: 'NAME', labelSize: 12 });
  expect(r.styles).toEqual(['#0070ff66', '#e6000066', '#00000000']);
  await frame.evaluate((root) => {
    window.gisworkbench.prefs.set('portalUrl', root);
    window.gisworkbench.commands.run('net.portal');
  }, po.portal);
  await frame.waitForSelector('[data-id="dialog:portal"]');
  await frame.click('[data-id="portal:search"]');
  await frame.waitForSelector('[data-id^="portal:item:"]');
  expect(await axe(frame, '[data-id="dialog:portal"]')).toEqual([]);
  await frame.click('[data-id="dialog:portal"] .dlg-x');
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});
