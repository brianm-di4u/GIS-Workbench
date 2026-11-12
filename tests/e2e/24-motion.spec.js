// 2.4 motion group (SDP-2.3 GR-18, GR-19).
// REQ-GAP-47 MIE4NITF: camera-set mosaics (CAMSDA), every MTIMSA time, MTIMFA/MIMCSA/TMINTA, lazy
// frame streaming (one layer per camera set, frames opened on demand), per-frame models, tiled
// JPEG 2000 frames, the WAMI chip and, on the hosted copy, the OPFS tile store for long sequences.
// Fixtures: fixtures/fx24/motion (build/fixtures/fx24-motion.mjs, written with the app's own NITF
// writer: no independent MIE4NITF sample exists, OD-05/O-12) and the BAMBI campaign files.
//
//   GW_DIST=dist-motion-mie npx playwright test tests/e2e/24-motion.spec.js --project=chrome

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { openApp, openFiles, servers, DIST } from './helpers.js';

const FX = resolve('fixtures/fx24/motion');
const F = (n) => join(FX, n);
const truth = JSON.parse(readFileSync(F('fx24_motion_truth.json'), 'utf8'));
const BAMBI = resolve(process.env.TE_CORPUS ?? '../TE-corpus', 'derived-mie4nitf-bambi');
test.describe.configure({ timeout: 240000 });

const seqReady = (frame, n) => frame.waitForFunction((n) => [...window.gisworkbench.layers.values()].filter((l) => l.info?.mie?.sequence && l.lutTex).length >= n, n, { timeout: 90000 });

test('REQ-GAP-47 MIE4NITF camera sets open as mosaic sequences: every MTIMSA time, cameras by CAMSDA, frames decoded on demand', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const log = await openFiles(frame, [F('mie_multicam.ntf')]);
  expect(log[0].errors).toEqual([]);
  expect(log[0].warnings.filter((w) => /MIE4NITF/.test(w))).toEqual([]);
  await seqReady(frame, 2);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()].filter((l) => l.info?.mie?.sequence);
    const all = [...app.layers.values()].filter((l) => l.info?.fileName === 'mie_multicam.ntf');
    const eo = ls.find((l) => l.info.mie.layer === 'EO');
    const ir = ls.find((l) => l.info.mie.layer === 'IR');
    const p = app.desktop.multiports[0].panes.find((x) => x.layers().includes(eo));
    app.desktop.multiports[0].setActivePane?.(p);
    app.store.transact('active', (tx) => tx.set(p.id, 'activeLayer', eo.id), { kind: 'load' });
    const opened0 = await app.mie.info(p);
    const px = async (l, x, y) => (await app.pool.run('pixels', { handle: l.handle, x, y, w: 1, h: 1, bands: [0] }, { affinity: l.affinity })).values[0][0];
    const vals = [];
    const lons = [];
    for (const k of [0, 3, 4, 7]) {
      await app.mie.show(k, p);
      vals.push([await px(eo, 7, 3), await px(eo, 96 + 7, 3), await px(eo, 7, 64 + 3), await px(eo, 150, 100)]);
      lons.push(eo.groundAt(0.5, 0.5, 0).lon);
    }
    const opened = await app.mie.info(p);
    const label = p.status.textContent;
    // The command steps too.
    await app.commands.run('mie.next');
    await new Promise((res) => setTimeout(res, 50));
    return {
      layers: all.length,
      seqs: ls.map((l) => ({ layer: l.info.mie.layer, set: l.info.mie.set, w: l.width, h: l.height, frames: l.info.mie.frames.length, ns: l.info.mie.frames.map((f) => f.ns), gaps: l.info.mie.gaps.length, cams: l.info.mie.cameras.map((c) => [c.x, c.y]) })),
      vals,
      lons,
      opened0,
      opened,
      label,
      after: eo.frame,
      model: eo.modelName,
      ir: { w: ir.width, type: ir.sampleType },
    };
  });
  const [te, ti] = truth.multicam.sequences;
  expect(r.layers).toBe(2); // two camera sets; eight + five frames are not layers
  const eo = r.seqs.find((s) => s.layer === 'EO');
  expect(eo).toMatchObject({ set: 1, w: te.width, h: te.height, frames: te.frames, gaps: 1, cams: te.cameras });
  expect(eo.ns).toEqual(te.times);
  expect(r.seqs.find((s) => s.layer === 'IR').ns).toEqual(ti.times);
  // cam*50 + frame*5 + (x+y)%5; the gap of the L-shaped mosaic is nodata 0.
  expect(r.vals).toEqual([0, 3, 4, 7].map((f) => [f * 5 + 0, 50 + f * 5, 100 + f * 5, 0]));
  // Each frame's model comes from its own IGEOLO corners: block 2 (frames 5–8) sits 0.008° east of
  // block 1 (frames 1–4 share its corners); IGEOLO rounds to whole arc-seconds.
  expect(r.lons[1] - r.lons[0]).toBeCloseTo(0, 9);
  expect(Math.abs(r.lons[2] - r.lons[0] - 0.008)).toBeLessThan(1 / 3600);
  expect(r.model).toMatch(/IGEOLO corners of the camera set/);
  // Lazy: at open only frame 0 (its three cameras' frames); after frames 1, 4, 5 and 8 were shown,
  // those four of the eight, 3 camera frames each.
  expect([r.opened0.framesOpened, r.opened0.sourcesOpened]).toEqual([1, 3]);
  expect([r.opened.framesOpened, r.opened.sourcesOpened]).toEqual([4, 12]);
  expect(r.opened0.store.enabled).toBe(false);
  expect(r.label).toBe('MIE4NITF frame 8/8 · 2025-10-25 12:00:03.500000000 UTC');
  expect(r.after).toBe(0); // next after the last frame wraps
  expect(r.ir).toEqual({ w: 80, type: 'u16' });
  expect(logs).toEqual([]);
});

test('REQ-GAP-47 playback is real time at the layer rate and reads ahead; tiled JPEG 2000 frames decode tile by tile', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [F('mie_long40.ntf')]);
  await seqReady(frame, 1);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()].find((x) => x.info?.mie?.sequence);
    const p = app.desktop.multiports[0].panes.find((x) => x.layers().includes(l));
    app.desktop.multiports[0].setActivePane?.(p);
    const fps = app.mie.play(p);
    const t0 = performance.now();
    await new Promise((res) => setTimeout(res, 1200));
    const wall = (performance.now() - t0) / 1000;
    const st = app.mie.stop();
    // A frame change in flight when the player stopped still completes.
    await new Promise((res) => setTimeout(res, 150));
    const idx = l.frame;
    const ahead = l.tiles.frameTiles((idx + 1) % 40).length;
    const v = (await app.pool.run('pixels', { handle: l.handle, x: 10, y: 0, w: 1, h: 1, bands: [0] }, { affinity: l.affinity })).values[0][0];
    const info = await app.mie.info(p);
    return { fps, idx, wall, st, ahead, v, rate: l.info.mie.rate, store: info.store };
  });
  console.log(`mie_long40 at 25 frames/s for ${r.wall.toFixed(2)} s: frame ${r.idx + 1} due ${Math.floor(r.wall * 25) + 1}; ${r.st.shown} shown, ${r.st.skipped} skipped`);
  // A long sequence on file:// has no OPFS (opaque origin): it says so and decodes as before.
  expect(r.store.enabled).toBe(false);
  expect(r.store.reason).toBeTruthy();
  expect(r.fps).toBe(25);
  // 1.2 s at 25 frames/s ≈ frame 30; the display may skip frames but keeps the clock.
  expect(r.idx).toBeGreaterThanOrEqual(Math.floor(r.wall * 25) - 6);
  expect(r.idx).toBeLessThanOrEqual(Math.ceil(r.wall * 25) + 2);
  expect(r.st.shown).toBeGreaterThan(10);
  expect(r.v).toBe((10 + 3 * r.idx) & 255);
  // The next frame's tiles were requested ahead of time.
  expect(r.ahead).toBeGreaterThan(0);

  await openFiles(frame, [F('mie_j2k.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.info?.fileName === 'mie_j2k.ntf' && l.lutTex), null, { timeout: 90000 });
  const j = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()].find((x) => x.info?.fileName === 'mie_j2k.ntf');
    const p = app.desktop.multiports[0].panes.find((x) => x.layers().includes(l));
    app.desktop.multiports[0].setActivePane?.(p);
    app.store.transact('active', (tx) => tx.set(p.id, 'activeLayer', l.id), { kind: 'load' });
    await app.mie.show(3, p);
    const row = (await app.pool.run('pixels', { handle: l.handle, x: 500, y: 99, w: 1, h: 3, bands: [0] }, { affinity: l.affinity })).values[0];
    return { row: Array.from(row), decoder: l.info.mie.decoder, frames: l.info.mie.frames.length, ic: l.info.subheader.IC };
  });
  expect(j).toEqual({ row: [(500 + 99 + 24) & 255, 160, 160], decoder: 'C8', frames: 4, ic: 'C8' });
  expect(logs).toEqual([]);
});

test('REQ-GAP-47 WAMI chip: the dialog passes axe; a chip of a region and frame range reopens with the same pixels and times', async ({ page }) => {
  const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [F('mie_multicam.ntf')]);
  await seqReady(frame, 2);
  await frame.evaluate(axeSource);
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()].find((x) => x.info?.mie?.layer === 'EO');
    const p = app.desktop.multiports[0].panes.find((x) => x.layers().includes(l));
    app.desktop.multiports[0].setActivePane?.(p);
    app.store.transact('active', (tx) => tx.set(p.id, 'activeLayer', l.id), { kind: 'load' });
    void app.commands.run('mie.chip');
  });
  const dlg = frame.locator('[data-id="dialog:mie-chip"]');
  await expect(dlg).toBeVisible();
  const v = await frame.evaluate(async () => (await window.axe.run(document.querySelector('[data-id="dialog:mie-chip"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`));
  expect(v).toEqual([]);
  await expect(dlg).toContainText('8 frames');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const out = await app.mie.chip(p, { x0: 90, y0: 60, w: 20, h: 10, first: 1, last: 5, step: 2, save: false });
    const file = new File([out.bytes], out.name);
    const before = app.layers.size;
    await app.openFiles([file]);
    const l = [...app.layers.values()].find((x) => x.info?.fileName === out.name);
    const q = app.desktop.multiports[0].panes.find((x) => x.layers().includes(l));
    const vals = [];
    for (let k = 0; k < l.info.mie.frames.length; k++) {
      await app.mie.show(k, q, l);
      vals.push(Array.from((await app.pool.run('pixels', { handle: l.handle, x: 0, y: 0, w: 20, h: 10, bands: [0] }, { affinity: l.affinity })).values[0]));
    }
    const eo = [...app.layers.values()].find((x) => x.info?.mie?.layer === 'EO' && x.info.fileName === 'mie_multicam.ntf');
    const ref = [];
    for (const f of [1, 3, 5]) {
      await app.mie.show(f, app.desktop.multiports[0].panes.find((x) => x.layers().includes(eo)), eo);
      ref.push(Array.from((await app.pool.run('pixels', { handle: eo.handle, x: 90, y: 60, w: 20, h: 10, bands: [0] }, { affinity: eo.affinity })).values[0]));
    }
    const g = l.groundAt(0.5, 0.5, 0);
    const ge = eo.groundAt(90.5, 60.5, 0);
    return { name: out.name, frames: out.frames, added: app.layers.size - before, ns: l.info.mie.frames.map((f) => f.ns), same: JSON.stringify(vals) === JSON.stringify(ref), w: l.width, h: l.height, dLat: g.lat - ge.lat, dLon: g.lon - ge.lon };
  });
  expect(r).toMatchObject({ name: 'mie_multicam_chip_f2-6.ntf', frames: 3, added: 1, same: true, w: 20, h: 10 });
  expect(r.ns).toEqual([1, 3, 5].map((f) => truth.multicam.sequences[0].times[f]));
  // IGEOLO keeps whole arc-seconds (≈ 30 m): the chip's corner is where the frame model puts it,
  // within that rounding of both files.
  expect(Math.abs(r.dLat)).toBeLessThan(2 / 3600);
  expect(Math.abs(r.dLon)).toBeLessThan(2 / 3600);
  expect(logs).toEqual([]);
});

test('REQ-GAP-47 BAMBI campaign MIE4NITF (real thermal frames in app-written containers) opens as one sequence in time order', async ({ page }) => {
  const f = join(BAMBI, 'flight_306_thermal_mie4nitf.ntf');
  test.skip(!existsSync(f), 'TE-corpus not mounted');
  const { frame, logs } = await openApp(page, 'file');
  const log = await openFiles(frame, [f]);
  expect(log[0].errors).toEqual([]);
  await seqReady(frame, 1);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()].find((x) => x.info?.mie?.sequence);
    const p = app.desktop.multiports[0].panes.find((x) => x.layers().includes(l));
    app.desktop.multiports[0].setActivePane?.(p);
    const fr = l.info.mie.frames;
    const steps = fr.slice(1).map((x, i) => x.ms - fr[i].ms);
    const segs = fr.map((x) => x.parts[0].seg);
    const c0 = l.groundAt(320, 256, 0);
    await app.mie.show(fr.length - 1, p);
    const c1 = l.groundAt(320, 256, 0);
    return { layers: app.layers.size, frames: fr.length, steps: [...new Set(steps)], ordered: segs.join() !== [...segs].sort((a, b) => a - b).join(), moved: app.core.inverse(c0.lat, c0.lon, c1.lat, c1.lon).distance, w: l.width, h: l.height };
  });
  expect(r.layers).toBe(1);
  expect(r.steps).toEqual([500]);
  expect(r.ordered).toBe(true); // segments written out of time order, shown in time order
  expect([r.w, r.h]).toEqual([640, 512]);
  expect(r.moved).toBeGreaterThan(0); // the drone's footprint moves with the frame
  console.log(`BAMBI flight_306: ${r.frames} frames, footprint centre moved ${r.moved.toFixed(1)} m over the sequence`);
  expect(logs).toEqual([]);
});

test('REQ-GAP-47 hosted copy: a long sequence keeps its tiles in OPFS and the second pass reads them back (file:// has no store)', async ({ page }) => {
  const srv = await servers(DIST);
  try {
    const { frame, logs } = await openApp(page, 'http', { srv });
    const pass = async () => {
      await openFiles(frame, [F('mie_long40.ntf')]);
      await seqReady(frame, 1);
      return frame.evaluate(async () => {
        const app = window.gisworkbench;
        const l = [...app.layers.values()].filter((x) => x.info?.mie?.sequence).at(-1);
        const p = app.desktop.multiports[0].panes.find((x) => x.layers().includes(l));
        app.desktop.multiports[0].setActivePane?.(p);
        app.store.transact('active', (tx) => tx.set(p.id, 'activeLayer', l.id), { kind: 'load' });
        // Show every frame and wait until its tiles are on screen.
        for (let k = 0; k < 40; k++) {
          await app.mie.show(k, p, l);
          for (let i = 0; i < 200 && (l.tiles.frameTiles(k).length === 0 || l.tiles.loading > 0); i++) await new Promise((r) => setTimeout(r, 10));
        }
        const info = await app.mie.info(p, { flush: true });
        return info.store;
      });
    };
    const a = await pass();
    expect(a.enabled).toBe(true);
    expect(a.writes).toBeGreaterThanOrEqual(40);
    const b = await pass();
    expect(b.hits).toBeGreaterThanOrEqual(40);
    expect(b.dir).toBe(a.dir);
    const cleared = await frame.evaluate(() => window.gisworkbench.commands.run('mie.clearcache'));
    expect(cleared.removed).toBeGreaterThanOrEqual(1);
    expect(logs).toEqual([]);
  } finally {
    await srv.close();
  }
});

// The 8192² tiled JPEG 2000 sequence on E: (build/fixtures/fx24-motion.mjs --large).
const LARGE = truth.large?.path;
test('REQ-GAP-47 8192² JPEG 2000 WAMI frames: the first view and a frame change decode only the tiles in view', async ({ page }) => {
  test.skip(!LARGE || !existsSync(LARGE), 'the large WAMI fixture is not on E:');
  const { frame, logs } = await openApp(page, 'file');
  const t0 = Date.now();
  await openFiles(frame, [LARGE]);
  await seqReady(frame, 1);
  const first = Date.now() - t0;
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()].find((x) => x.info?.mie?.sequence);
    const p = app.desktop.multiports[0].panes.find((x) => x.layers().includes(l));
    app.desktop.multiports[0].setActivePane?.(p);
    // 1:1 at the frame centre: full-resolution tiles of one view.
    p.oneToOne?.();
    p.centreOn?.(4096, 4096);
    const settle = async (k) => {
      const t = performance.now();
      await new Promise((res) => setTimeout(res, 30));
      for (let i = 0; i < 3000 && (l.tiles.loading > 0 || l.tiles.frameTiles(k).length === 0); i++) await new Promise((res) => setTimeout(res, 10));
      return performance.now() - t;
    };
    const view0 = await settle(0);
    const t = performance.now();
    await app.mie.show(3, p, l);
    const change = performance.now() - t + (await settle(3));
    const v = (await app.pool.run('pixels', { handle: l.handle, x: 4000, y: 110, w: 1, h: 1, bands: [0] }, { affinity: l.affinity })).values[0][0];
    return { view0, change, tiles: l.tiles.frameTiles(3).length, v, frames: l.info.mie.frames.length };
  });
  console.log(`8192² WAMI: open to first display ${first} ms; full-resolution view ${r.view0.toFixed(0)} ms; frame change with ${r.tiles} view tiles ${r.change.toFixed(0)} ms`);
  expect(r.frames).toBe(6);
  expect(r.v).toBe(160); // the frame-number band of frame 4
  expect(logs).toEqual([]);
});

// ---- REQ-GAP-48: MPEG-2 video decoded in WebAssembly (S-58) ----
// MPEG-2 (H.262) in MPEG-TS, program streams and bare streams plays through the app's own decoder
// (crates/gw-codec/src/mpeg2v.rs in the lazy `mpeg` bundle) with the same controls and KLV sync as
// MPEG-1; the sidecar transcode (REQ-FMV-15) is offered only when that decoder fails on a stream.
// Bit-exactness against ffmpeg is checked in tests/unit/mpeg2v.test.js and
// crates/gw-codec/tests/mpeg2v_ref.rs; here: real time, seeks, KLV sync, capture, fallback.

const M2 = JSON.parse(readFileSync(F('mpeg2_truth.json'), 'utf8'));
const SCN30 = resolve(process.env.TE_CORPUS ?? '../TE-corpus', 'derived-fmv-variants', 'truck_mpeg2_klv.ts');
const DATA = process.env.GW24_DATA ?? 'E:/gwb24/data-motion';
const I1080 = join(DATA, 'mpeg2', 'truck_i1080_klv.ts');

async function clipReady(frame, name) {
  await frame.waitForFunction((n) => {
    const fmv = window.gisworkbench.fmv;
    const c = [...(fmv?.clips.values() ?? [])].find((x) => x.name === n);
    const v = c && fmv.viewOf(c);
    return v && (v.metadataOnly || v.media?.shown >= 0);
  }, name, { timeout: 120000 });
}

/** Play `ms` at 1× and report the clock, the frames shown, drops, stalls and the KLV sync. */
async function playFor(frame, ms) {
  return frame.evaluate(async (ms) => {
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    const m = v.media;
    const s0 = { ...m.stats };
    const seen = new Set();
    let syncBad = 0;
    let checks = 0;
    const t0 = performance.now();
    const f0 = m.shown;
    v.play();
    await new Promise((r) => {
      const tick = () => {
        if (m.shown >= 0) {
          seen.add(m.shown);
          // The FMV time (map, HUD, KLV state) follows the picture on the canvas.
          checks++;
          if (app.fmv.sync.frame !== m.shown && app.fmv.sync.frame !== m.shown - 1) syncBad++;
        }
        if (performance.now() - t0 > ms) return r();
        requestAnimationFrame(tick);
      };
      tick();
    });
    const wall = (performance.now() - t0) / 1000;
    const shown = m.shown;
    v.pause();
    const st = app.fmv.stateAt(clip, shown);
    return { wall, mediaAdvance: clip.frames[shown].t - clip.frames[Math.max(0, f0)].t, frames: seen.size, due: wall * clip.fps, dropped: m.stats.dropped - s0.dropped, stalls: m.stats.stalls - s0.stalls, fps: clip.fps, syncBad, checks, stale: st?.stale ?? null, footprint: !!st?.footprint };
  }, ms);
}

test('REQ-GAP-48 MPEG-2 KLV transport stream (576i, field DCT/MC, B-15, alternate scan) plays in the browser without the sidecar: real time, exact seeks and steps, KLV sync, capture', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const log = await openFiles(frame, [F('mpeg2_i576_klv.ts')]);
  expect(log[0]?.errors ?? []).toEqual([]);
  await clipReady(frame, 'mpeg2_i576_klv.ts');
  const a = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    const toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ');
    return { codec: clip.codec, container: clip.container, frames: clip.frames.length, w: clip.width, h: clip.height, klv: clip.packets.length, ok: clip.packets.filter((k) => k.ok).length, native: !!v.media, metadataOnly: !!v.metadataOnly, canvas: !!document.querySelector('[data-id="video-canvas"]'), info: v.media.info, toasts, capture: app.commands.enabled('fmv.capture'), convert: !!document.querySelector('[data-id="video-convert"]') };
  });
  expect(a).toMatchObject({ codec: 'mp2v', container: 'ts', frames: M2.files['mpeg2_i576_klv.ts'].frames, w: 720, h: 576, native: true, metadataOnly: false, canvas: true, capture: true, convert: false });
  expect(a.info).toMatchObject({ decoder: 'mpeg2', mpeg2: true, width: 720, height: 576, progressiveSequence: false });
  expect(a.klv).toBeGreaterThan(30);
  expect(a.ok).toBe(a.klv);
  expect(a.toasts).not.toMatch(/sidecar transcode/);

  const play = await playFor(frame, 2500);
  console.log('MPEG-2 576i playback:', JSON.stringify(play));
  expect(play.mediaAdvance).toBeGreaterThan(play.wall * 0.9);
  expect(play.frames).toBeGreaterThan(play.due * 0.85);
  expect(play.dropped).toBeLessThanOrEqual(3);
  expect(play.syncBad).toBe(0);
  expect(play.stale).toBe(false);
  expect(play.footprint).toBe(true);

  const s = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    const m = v.media;
    const wait = (i) => new Promise((r) => { const f = () => (m.shown === i && !m.seeking ? r() : setTimeout(f, 5)); f(); });
    const out = { seeks: [] };
    for (const i of [97, 4, 60, 119, 31]) {
      const t = performance.now();
      v.seekFrame(i);
      await wait(i);
      out.seeks.push([i, v.frame, Math.round(performance.now() - t)]);
    }
    await v.step(1);
    await wait(32);
    await v.step(-1);
    await v.step(-1);
    await wait(30);
    out.after = v.frame;
    // Capture (an exact frame from its own decoder session) against the canvas.
    const bmp = await app.fmv.frameBitmap(clip, 30);
    const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
    c.drawImage(bmp, 0, 0);
    const A = c.getImageData(0, 0, bmp.width, bmp.height).data;
    const B = v.surface.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
    let max = 0;
    let se = 0;
    const bias = [0, 0, 0];
    const hist = new Array(256).fill(0);
    for (let k = 0; k < A.length; k += 4) for (let q = 0; q < 3; q++) {
      const d = A[k + q] - B[k + q];
      se += d * d;
      bias[q] += d;
      hist[Math.abs(d)]++;
      max = Math.max(max, Math.abs(d));
    }
    let acc = 0;
    let p99 = 0;
    for (let d = 0; d < 256; d++) {
      acc += hist[d];
      if (acc >= 0.99 * (A.length * 0.75)) {
        p99 = d;
        break;
      }
    }
    out.capture = [bmp.width, bmp.height];
    out.canvasVsCapture = { max, p99, bias: bias.map((b) => +(b / (A.length / 4)).toFixed(3)), psnr: se ? 10 * Math.log10((255 * 255) / (se / (A.length * 0.75))) : 99 };
    const cap = await app.fmv.capture(clip, 30, { save: false });
    out.cap = { png: cap.png.size > 1000, footprint: !!cap.footprint, w: cap.width };
    return out;
  });
  console.log('MPEG-2 576i seeks [target, frame, ms]:', JSON.stringify(s));
  for (const [i, f, ms] of s.seeks) {
    expect(f).toBe(i);
    expect(ms).toBeLessThan(1000);
  }
  expect(s.after).toBe(30);
  expect(s.capture).toEqual([720, 576]);
  // The canvas shows exactly the pixels a capture saves (the decoder's own RGB conversion).
  expect(s.canvasVsCapture.max).toBe(0);
  expect(s.cap).toEqual({ png: true, footprint: true, w: 720 });
  expect(logs).toEqual([]);
});

test('REQ-GAP-48 MPEG-2 field pictures (I/P, P/P, B/B field pairs, 16×8 and dual-prime prediction) play natively', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [F('mpeg2_fields.ts')]);
  await clipReady(frame, 'mpeg2_fields.ts');
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    const m = v.media;
    const wait = (i) => new Promise((res) => { const f = () => (m.shown === i && !m.seeking ? res() : setTimeout(f, 5)); f(); });
    const shown = [];
    for (let i = 0; i < clip.frames.length; i++) {
      v.seekFrame(i);
      await wait(i);
      shown.push(m.shown);
    }
    const info = await app.pool.run('mpvopen', m.sessionArgs(), { kind: 'decode' }).then(async (o) => {
      const r = await app.pool.run('mpvrun', { session: o.session, count: 8 }, { kind: 'decode' });
      for (const f of r.frames) f.bitmap?.close?.();
      return { info: o.info, n: r.frames.length };
    });
    return { codec: clip.codec, frames: clip.frames.length, native: !!m, metadataOnly: !!v.metadataOnly, shown, first: info };
  });
  expect(r).toMatchObject({ codec: 'mp2v', frames: 8, native: true, metadataOnly: false, shown: [0, 1, 2, 3, 4, 5, 6, 7] });
  expect(r.first.info).toMatchObject({ decoder: 'mpeg2', width: 720, height: 576 });
  expect(logs).toEqual([]);
});

test('REQ-GAP-48 REQ-FMV-15 an MPEG-2 stream the app cannot decode (4:2:2 Profile) falls back to the sidecar route', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [F('mpeg2_422.ts')]);
  await clipReady(frame, 'mpeg2_422.ts');
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    const toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ');
    return { codec: clip.codec, metadataOnly: !!v.metadataOnly, failed: clip.nativeFailed?.message ?? null, msg: v.msg.textContent, toasts, capture: app.commands.enabled('fmv.capture'), canvas: !!document.querySelector('[data-id="video-canvas"]') };
  });
  expect(r).toMatchObject({ codec: 'mp2v', metadataOnly: true, capture: false, canvas: false });
  expect(r.failed).toMatch(/4:2:2/);
  expect(r.msg).toMatch(/MPEG-2 decoding failed/);
  expect(r.msg).toMatch(/video-h264-klv/);
  expect(r.toasts).toMatch(/MPEG-2 video is indexed/);
  // With the sidecar's command present (a stand-in), the panel offers the transcode.
  await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.commands.define({ id: 'sidecar.convert', label: 'Convert with Sidecar', run: (args) => (window.__convert = { names: args.files.map((f) => f.name), profile: args.profile }) });
    await app.fmv.closeVideo(app.fmv.viewOf(app.fmv.activeClip()).pane);
  });
  await openFiles(frame, [F('mpeg2_422.ts')]);
  await clipReady(frame, 'mpeg2_422.ts');
  const c = await frame.evaluate(async () => {
    const b = document.querySelector('[data-id="video-convert"]');
    b?.click();
    await new Promise((res) => setTimeout(res, 100));
    return { button: b?.textContent ?? null, ran: window.__convert ?? null };
  });
  expect(c).toEqual({ button: 'Convert with Sidecar', ran: { names: ['mpeg2_422.ts'], profile: 'video-h264-klv' } });
  expect(logs).toEqual([]);
});

test('REQ-GAP-48 S-58 SCN-30 corpus MPEG-2 KLV transport stream (1080p, 15.7 Mb/s) plays natively in real time with every KLV packet', async ({ page }) => {
  test.skip(!existsSync(SCN30), 'TE-corpus not mounted');
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [SCN30]);
  await clipReady(frame, 'truck_mpeg2_klv.ts');
  const a = await frame.evaluate(() => {
    const clip = window.gisworkbench.fmv.activeClip();
    const v = window.gisworkbench.fmv.viewOf(clip);
    return { codec: clip.codec, frames: clip.frames.length, w: clip.width, h: clip.height, klv: clip.packets.length, ok: clip.packets.filter((k) => k.ok).length, native: !!v.media, metadataOnly: !!v.metadataOnly };
  });
  expect(a).toMatchObject({ codec: 'mp2v', w: 1920, h: 1080, klv: 288, ok: 288, native: true, metadataOnly: false });
  expect(a.frames).toBeGreaterThan(1000);
  const play = await playFor(frame, 5000);
  console.log('SCN-30 truck_mpeg2_klv.ts 1080p playback:', JSON.stringify(play));
  expect(play.mediaAdvance).toBeGreaterThan(play.wall * 0.9);
  expect(play.frames).toBeGreaterThan(play.due * 0.85);
  expect(play.syncBad).toBe(0);
  expect(play.stale).toBe(false);
  expect(logs).toEqual([]);
});

test('REQ-GAP-48 S-58 1080i MPEG-2 (field DCT/MC, 20 Mb/s, KLV) decodes in real time on this machine', async ({ page }) => {
  test.skip(!existsSync(I1080), 'E:/gwb24/data-motion/mpeg2/truck_i1080_klv.ts not generated (docs/validation/2.4/motion.md)');
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [I1080]);
  await clipReady(frame, 'truck_i1080_klv.ts');
  const a = await frame.evaluate(() => {
    const clip = window.gisworkbench.fmv.activeClip();
    const v = window.gisworkbench.fmv.viewOf(clip);
    return { codec: clip.codec, frames: clip.frames.length, h: clip.height, klv: clip.packets.length, native: !!v.media, info: v.media?.info };
  });
  expect(a).toMatchObject({ codec: 'mp2v', frames: 600, h: 1080, klv: 96, native: true });
  expect(a.info.progressiveSequence).toBe(false);
  const play = await playFor(frame, 6000);
  console.log('1080i MPEG-2 playback:', JSON.stringify(play));
  expect(play.mediaAdvance).toBeGreaterThan(play.wall * 0.95);
  expect(play.frames).toBeGreaterThan(play.due * 0.9);
  expect(play.syncBad).toBe(0);
  expect(logs).toEqual([]);
});
