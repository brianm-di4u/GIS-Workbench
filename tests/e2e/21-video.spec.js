// 2.1 video group (SDP-2.1 FC-22, FC-23; REQ-FMT-52, REQ-FMV-15, REQ-FMT-56): MPEG program
// streams open in the FMV player; MPEG-1 video (PS, MPEG-TS, bare stream) plays through the
// app's own decoder with seeking, frame stepping, KLV sync, capture and burn-in export; MPEG-2
// video is indexed with its KLV and, since 2.4 (REQ-GAP-48), plays through the app's MPEG-2 decoder.
//
//   GW_DIST=dist-21-video npx playwright test tests/e2e/21-video.spec.js --project=chrome --workers=2

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles, DIST } from './helpers.js';

const HTML = DIST; // GW_DIST (helpers.js): a build folder or its .html
const D = resolve('fixtures/fx21/video');
const truth = JSON.parse(readFileSync(resolve(D, 'video_truth.json'), 'utf8'));
const F = (n) => resolve(D, n);

test.describe.configure({ timeout: 180000 });

async function clipOpen(frame, name) {
  await frame.waitForFunction((n) => {
    const fmv = window.gisworkbench.fmv;
    const c = [...(fmv?.clips.values() ?? [])].find((x) => x.name === n);
    const v = c && fmv.viewOf(c);
    return v && (v.metadataOnly || v.media?.shown >= 0);
  }, name, { timeout: 90000 });
}

test('REQ-FMT-52 FC-22 MPEG-1 program stream with KLV plays in real time, seeks, steps and stays in KLV sync', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file', { htmlPath: HTML });
  const log = await openFiles(frame, [F('mpeg1_ps_klv.mpg')]);
  expect(log[0]?.errors ?? []).toEqual([]);
  await clipOpen(frame, 'mpeg1_ps_klv.mpg');
  const a = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    return { codec: clip.codec, container: clip.container, frames: clip.frames.length, fps: clip.fps, w: clip.width, h: clip.height, klv: clip.packets.length, ok: clip.packets.filter((k) => k.ok).length, native: !!v.media, metadataOnly: v.metadataOnly, canvas: !!document.querySelector('[data-id="video-canvas"]') };
  });
  expect(a).toMatchObject({ codec: 'mp1v', container: 'ps', frames: 300, fps: 30, w: 640, h: 480, klv: truth.klvInserted.count, ok: truth.klvInserted.count, native: true, metadataOnly: false, canvas: true });

  // Real-time playback for 3 s at 1×: the clock follows wall time and frames are not dropped.
  const play = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const v = app.fmv.viewOf(app.fmv.activeClip());
    const m = v.media;
    const s0 = { ...m.stats };
    const seen = new Set();
    const t0 = performance.now();
    v.play();
    await new Promise((r) => {
      const tick = () => {
        seen.add(v.frame);
        if (performance.now() - t0 > 3000) return r();
        requestAnimationFrame(tick);
      };
      tick();
    });
    const wall = (performance.now() - t0) / 1000;
    const media = m.currentTime;
    v.pause();
    const c = v.surface.getContext('2d').getImageData(0, 0, 640, 480).data;
    let lit = 0;
    for (let i = 0; i < c.length; i += 4 * 97) if (c[i] + c[i + 1] + c[i + 2] > 60) lit++;
    return { wall, media, frames: seen.size, dropped: m.stats.dropped - s0.dropped, stalls: m.stats.stalls - s0.stalls, lit, playing: v.playing };
  });
  console.log('MPEG-1 640×480 playback:', JSON.stringify(play));
  expect(play.media).toBeGreaterThan(play.wall * 0.9);
  expect(play.frames).toBeGreaterThan(play.wall * 30 * 0.9);
  expect(play.dropped).toBeLessThanOrEqual(3);
  expect(play.lit).toBeGreaterThan(100);
  expect(play.playing).toBe(false);

  // Seek ≤ 1 s, exact frame; frame step both ways; KLV state follows the frame.
  const s = await frame.evaluate(async (k0) => {
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    const m = v.media;
    const wait = (i) => new Promise((r) => { const f = () => (m.shown === i && !m.seeking ? r() : setTimeout(f, 5)); f(); });
    const out = {};
    let t = performance.now();
    v.seekFrame(200);
    await wait(200);
    out.seekMs = performance.now() - t;
    out.frame = v.frame;
    t = performance.now();
    await v.step(1);
    await wait(201);
    out.stepFwdMs = performance.now() - t;
    t = performance.now();
    await v.step(-1);
    await v.step(-1);
    await wait(199);
    out.stepBackMs = performance.now() - t;
    out.after = v.frame;
    // KLV at frame 199: the inserted platform track at t = 199 / 30 s (10 Hz, interpolated).
    const st = app.fmv.stateAt(clip, 199);
    const tk = clip.frames[199].t;
    out.lat = st.lat;
    out.want = 38.8895 + 0.0004 * tk;
    out.stale = st.stale;
    // Exact frame for capture equals the frame on screen.
    const bmp = await app.fmv.frameBitmap(clip, 199);
    const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
    c.drawImage(bmp, 0, 0);
    const a = c.getImageData(0, 0, 640, 480).data;
    const b = v.surface.getContext('2d').getImageData(0, 0, 640, 480).data;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    out.captureDiff = diff;
    out.capture = [bmp.width, bmp.height];
    return out;
  }, truth.klvInserted);
  console.log('MPEG-1 seek/step:', JSON.stringify(s));
  expect(s.frame).toBe(200);
  expect(s.after).toBe(199);
  expect(s.seekMs).toBeLessThan(1000);
  expect(s.stepBackMs).toBeLessThan(2000);
  expect(s.lat).toBeCloseTo(s.want, 5);
  expect(s.stale).toBe(false);
  expect(s.capture).toEqual([640, 480]);
  expect(s.captureDiff).toBe(0);

  // Burn-in export plays through the MPEG-1 decoder.
  const blob = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const b = await app.fmv.exportClip(app.fmv.activeClip(), { from: 0, to: 45, save: false });
    return b.size;
  });
  expect(blob).toBeGreaterThan(1000);
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
});

test('REQ-FMT-52 FC-22 MPEG-1 in MPEG-TS and a bare MPEG-1 stream play through the same decoder', async ({ page }) => {
  const { frame } = await openApp(page, 'file', { htmlPath: HTML });
  await openFiles(frame, [F('mpeg1_ts_klv.ts')]);
  await clipOpen(frame, 'mpeg1_ts_klv.ts');
  const a = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    const m = v.media;
    v.seekFrame(150);
    await new Promise((r) => { const f = () => (m.shown === 150 && !m.seeking ? r() : setTimeout(f, 5)); f(); });
    return { codec: clip.codec, container: clip.container, frames: clip.frames.length, klv: clip.packets.filter((k) => k.ok).length, native: !!m, h: clip.height, frame: v.frame, hasFootprint: !!app.fmv.stateAt(clip, 150)?.footprint };
  });
  expect(a).toMatchObject({ codec: 'mp1v', container: 'ts', frames: 300, native: true, h: 360, frame: 150, hasFootprint: true });
  expect(a.klv).toBeGreaterThan(250);
  await openFiles(frame, [F('mpeg1.m1v')]);
  await clipOpen(frame, 'mpeg1.m1v');
  const b = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    // No KLV: the frame capture saves the PNG and JSON without a georeference, and says so.
    const cap = await app.fmv.capture(clip, 10, { save: false });
    return { codec: clip.codec, container: clip.container, frames: clip.frames.length, native: !!app.fmv.viewOf(clip).media, cap: { footprint: cap.footprint, png: cap.png.size > 1000, w: cap.width, reason: cap.reason } };
  });
  expect(b).toEqual({ codec: 'mp1v', container: 'es', frames: truth.files['mpeg1.m1v'].video.packets, native: true, cap: { footprint: null, png: true, w: 640, reason: 'the clip carries no KLV' } });
});

// Since 2.4 (REQ-GAP-48) MPEG-2 plays through the app's own decoder; the sidecar route
// (REQ-FMV-15) is offered only when that decoder fails on a stream (tests/e2e/24-motion.spec.js).
test('REQ-FMV-15 REQ-FMT-56 FC-23 REQ-GAP-48 MPEG-2 video (program stream and MPEG-TS with KLV) is indexed and plays through the app decoder, without the sidecar route', async ({ page }) => {
  const { frame } = await openApp(page, 'file', { htmlPath: HTML });
  // With the sidecar's command present (a stand-in), a decodable MPEG-2 clip still plays natively.
  await frame.evaluate(() => window.gisworkbench.commands.define({ id: 'sidecar.convert', label: 'Convert with Sidecar', run: (args) => (window.__convert = args) }));
  for (const [n, klv] of [['mpeg2_ps.mpg', false], ['mpeg2_ts_klv.ts', true]]) {
    await openFiles(frame, [F(n)]);
    await clipOpen(frame, n);
    const r = await frame.evaluate(async (n) => {
      const app = window.gisworkbench;
      const clip = [...app.fmv.clips.values()].find((c) => c.name === n);
      const v = app.fmv.viewOf(clip);
      const toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ');
      v.seekFrame(40);
      await new Promise((res) => { const f = () => (v.media?.shown === 40 && !v.media.seeking ? res() : setTimeout(f, 5)); f(); });
      return { codec: clip.codec, frames: clip.frames.length, klv: clip.packets.length, metadataOnly: !!v.metadataOnly, native: !!v.media, decoder: v.media?.info?.decoder, frame: v.frame, toasts, capture: app.commands.enabled('fmv.capture'), convert: !!document.querySelector('[data-id="video-convert"]') };
    }, n);
    expect(r.codec).toBe('mp2v');
    expect(r.frames).toBe(truth.files[n].video.packets);
    expect(r).toMatchObject({ metadataOnly: false, native: true, decoder: 'mpeg2', frame: 40, capture: true, convert: false });
    expect(r.toasts).not.toMatch(/MPEG-2 video is indexed/);
    if (klv) expect(r.klv).toBeGreaterThan(250);
  }
});

// The real archive (TE-corpus, D: USB disk): seeks on a 10.7-minute MPEG-1 program stream.
const MISSION = resolve(process.env.TE_CORPUS ?? '../TE-corpus', 'mpeg1-ps-prelinger/MissionA1942.mpg');
test('REQ-FMT-52 FC-22 real MPEG-1 program stream (Prelinger, 112 MB, 19,243 pictures): seeks land on the exact frame in under 1 s', async ({ page }) => {
  test.skip(!existsSync(MISSION), 'TE-corpus not mounted');
  const { frame } = await openApp(page, 'file', { htmlPath: HTML });
  await openFiles(frame, [MISSION]);
  await clipOpen(frame, 'MissionA1942.mpg');
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    const m = v.media;
    const wait = (i) => new Promise((res) => { const f = () => (m.shown === i && !m.seeking ? res() : setTimeout(f, 2)); f(); });
    const times = [];
    for (const i of [9000, 15000, 120, 19000, 4321, 12345]) {
      const t = performance.now();
      v.seekFrame(i);
      await wait(i);
      times.push(Math.round(performance.now() - t));
    }
    return { frames: clip.frames.length, codec: clip.codec, times, frame: v.frame };
  });
  console.log('MissionA1942 seeks (ms):', r.times.join(', '));
  expect(r).toMatchObject({ frames: 19243, codec: 'mp1v', frame: 12345 });
  expect(Math.max(...r.times)).toBeLessThan(1000);
});
