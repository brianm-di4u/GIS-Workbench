// SCN-15 FMV with KLV footprint, plus GMTI overlay, on FX-10 (MPEG-TS + ST 0601) and FX-11
// (STANAG 4607) (Appendix E AT-15.1..15.5), with the R3 FMV Shoulds/Coulds: ST 0102 banners,
// time basis, DVR, HUD, VMTI, event log, frame capture, metadata-only mode, CSV metadata,
// STANAG 4676 tracks, mensuration and linked panels.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const D10 = resolve('fixtures/fx10');
const D11 = resolve('fixtures/fx11');
const truth = JSON.parse(readFileSync(resolve(D10, 'fx10_truth.json'), 'utf8'));
const gtruth = JSON.parse(readFileSync(resolve(D11, 'fx11_truth.json'), 'utf8'));
const TS = (n) => resolve(D10, n);

test.describe.configure({ timeout: 300000 });

async function clipOpen(frame, n = 1) {
  await frame.waitForFunction((n) => window.gisworkbench.fmv?.clips.size >= n && [...window.gisworkbench.fmv.clips.values()].every((c) => window.gisworkbench.fmv.viewOf(c)), n, { timeout: 90000 });
}

// Geodesic distance (m) in the page through the core.
const DIST = `(a, b) => window.gisworkbench.core.inverse(a[0], a[1], b[0], b[1]).distance`;

test('SCN-15 AT-15.1 REQ-FMT-11 REQ-FMV-01 REQ-FMV-02 REQ-FMV-03 REQ-FMV-04 FX-10 KLV checksums, Items 1/2/65, unknown items listed, ST 0102 banner, time basis', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [TS('fx10.ts')]);
  await clipOpen(frame);
  const a = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const ok = clip.packets.filter((k) => k.ok).length;
    const items = clip.packets.every((k) => [1, 2, 65].every((t) => k.p.items.some((x) => x.t === t)));
    app.commands.run('fmv.klv');
    await new Promise((r) => setTimeout(r, 300));
    const dlg = document.querySelector('[data-id="dialog:fmv-klv"]');
    const rows = dlg?.querySelectorAll('[data-id="klv-table"] tbody tr').length ?? 0;
    const head = dlg?.querySelector('[data-id="klv-head"]')?.textContent ?? '';
    [...(dlg?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Close')?.click();
    const csv = app.fmv.klvCsv(clip);
    return { n: clip.packets.length, ok, items, frames: clip.frames.length, fps: clip.fps, codec: clip.codec, rows, head, csvLines: csv.trim().split('\n').length, status: document.querySelector('[data-id="status:klvtime"]')?.textContent, basis: app.fmv.basisLabel(clip), hint: clip.basisHint };
  });
  expect(a.n).toBe(300);
  expect(a.ok).toBe(300);
  expect(a.items).toBe(true);
  expect(a.frames).toBe(300);
  expect(a.fps).toBe(30);
  expect(a.codec).toMatch(/^avc1\./);
  expect(a.rows).toBeGreaterThan(20);
  expect(a.head).toMatch(/checksum OK/);
  expect(a.head).toMatch(/version 17/);
  expect(a.csvLines).toBe(301);
  expect(a.status).toMatch(/MISP→UTC -29\.0 s/);
  expect(a.hint).toMatch(/whole minute/);

  // fx10_b: async KLV, two broken checksums, an unknown item, ST 0102, Item 136.
  await openFiles(frame, [TS('fx10_b.ts')]);
  await frame.waitForFunction(() => window.gisworkbench.fmv.activeClip()?.name === 'fx10_b.ts' && window.gisworkbench.fmv.viewOf(window.gisworkbench.fmv.activeClip()), null, { timeout: 60000 });
  const b = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    v.seekFrame(5);
    const bad = clip.packets.map((k, i) => (k.ok ? -1 : i)).filter((i) => i >= 0);
    const asyncTimed = clip.packets.every((k) => !k.sync && k.tMux !== null);
    app.commands.run('fmv.klv');
    await new Promise((r) => setTimeout(r, 300));
    const dlg = document.querySelector('[data-id="dialog:fmv-klv"]');
    const unk = dlg?.querySelector('tr[data-tag="150"]');
    const unknownRow = unk ? { cls: unk.className, text: unk.textContent } : null;
    const nested = [...(dlg?.querySelectorAll('tbody tr') ?? [])].map((r) => r.textContent).filter((t) => /Security Classification|VTarget/.test(t)).length;
    [...(dlg?.querySelectorAll('button') ?? [])].find((x) => x.textContent === 'Close')?.click();
    const banner = { top: v.pane.bannerTop.textContent, bottom: v.pane.bannerBottom.textContent, hidden: v.pane.bannerTop.hidden };
    // A conflicting project marking: the higher one shows, flagged.
    app.store.transact('m', (tx) => tx.set(app.project().id, 'marking', { level: 'C', raw: 'C', codewords: '', control: '', release: '', source: 'project' }), { kind: 'load' });
    v.seekFrame(6);
    const conflict = { top: v.pane.bannerTop.textContent, flag: v.pane.bannerTop.dataset.conflict };
    app.store.transact('m', (tx) => tx.set(app.project().id, 'marking', null), { kind: 'load' });
    v.seekFrame(7);
    // Frames 100/101 carry broken packets: their state comes from the neighbours (not stale).
    const s100 = app.fmv.stateAt(clip, 100);
    const t0 = app.fmv.stateAt(clip, 0).utcMs;
    app.fmv.setBasis(clip, 'utc');
    const t1 = app.fmv.stateAt(clip, 0).utcMs;
    const labelUtc = app.fmv.basisLabel(clip);
    app.fmv.setBasis(clip, 'misp');
    return { bad, asyncTimed, unknownRow, nested, banner, conflict, s100: { stale: s100.stale, packet: clip.packets.indexOf(s100.packet) }, shift: (t1 - t0) / 1000, labelUtc, label: app.fmv.basisLabel(clip), leap: clip.leap };
  });
  expect(b.bad).toEqual([100, 101]);
  expect(b.asyncTimed).toBe(true);
  expect(b.unknownRow.cls).toMatch(/unknown/);
  expect(b.unknownRow.text).toMatch(/deadbeef/);
  expect(b.nested).toBeGreaterThanOrEqual(3);
  expect(b.banner.top).toBe('UNCLASSIFIED//REL TO XN');
  expect(b.banner.bottom).toBe('UNCLASSIFIED//REL TO XN');
  expect(b.conflict.top).toMatch(/^CONFIDENTIAL.*⚠ KLV ST 0102 U vs other markings C/);
  expect(b.conflict.flag).toBe('true');
  expect(b.s100.stale).toBe(false);
  expect(b.s100.packet).toBe(99);
  expect(b.shift).toBeCloseTo(28.999918, 5);
  expect(b.labelUtc).toMatch(/legacy UTC/);
  expect(b.label).toMatch(/Item 136/);
  expect(b.leap).toBe(37);
  expect(logs).toEqual([]);
});

test('SCN-15 AT-15.2 REQ-FMV-07 REQ-SNS-20 FX-10 footprints within 1 m of the truth: full corners, offset corners and computed from the KLV frame model', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const FR = [0, 77, 100, 150, 299];
  const res = {};
  for (const [file, key] of [['fx10.ts', 'corners_ul_ur_lr_ll'], ['fx10_b.ts', 'corners_ul_ur_lr_ll'], ['fx10_c.ts', 'computed_corners']]) {
    await openFiles(frame, [TS(file)]);
    await frame.waitForFunction((n) => window.gisworkbench.fmv.activeClip()?.name === n && window.gisworkbench.fmv.viewOf(window.gisworkbench.fmv.activeClip()), file, { timeout: 60000 });
    res[file] = await frame.evaluate(
      async ({ FR, want, DIST }) => {
        const d = eval(DIST); // test-side helper text, evaluated in the page under the test harness
        const app = window.gisworkbench;
        const clip = app.fmv.activeClip();
        return FR.map((i, k) => {
          const st = app.fmv.stateAt(clip, i);
          return { i, source: st.footprintSource, err: Math.max(...st.footprint.map((c, q) => d(c, want[k][q]))), check: st.check };
        });
      },
      { FR, want: FR.map((i) => truth.frames[i][key]), DIST },
    );
  }
  for (const [file, rows] of Object.entries(res)) {
    for (const r of rows) {
      expect(r.err, `${file} frame ${r.i} (${r.source})`).toBeLessThan(1);
      if (r.check) expect(r.check.flagged, `${file} frame ${r.i} centre check`).toBe(false);
    }
  }
  expect(res['fx10.ts'][0].source).toMatch(/Items 82–89/);
  expect(res['fx10_b.ts'][0].source).toMatch(/Items 26–33/);
  expect(res['fx10_c.ts'][0].source).toMatch(/computed \(KLV frame model at 10\.\d m HAE\)/);
  // The map draws the active clip's footprint (on its next render pass, so wait for it).
  await frame.waitForFunction(() => window.gisworkbench.fmv.lastMap?.footprint, null, { timeout: 10000 });
  const m = await frame.evaluate(() => window.gisworkbench.fmv.lastMap);
  expect(m.footprint.length).toBe(4);
  expect(logs).toEqual([]);
});

test('SCN-15 AT-15.3 REQ-FMV-05 REQ-FMV-06 REQ-FMV-08 FX-10 map, video and slider within one frame during playback; exact WebCodecs steps; DVR rate and A–B loop; HUD', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [TS('fx10.ts')]);
  await clipOpen(frame);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    app.fmv.sync.history.length = 0;
    v.play();
    await sleep(3000);
    v.pause();
    const hist = app.fmv.sync.history.filter((x) => x.video >= 0);
    const worst = Math.max(...hist.map((x) => Math.max(Math.abs(x.video - x.map), Math.abs(x.video - x.slider))));
    const advanced = v.frame;
    // Exact frame steps (WebCodecs): the background stripes move 4 px per frame and invert as the
    // checker scrolls, so the phase identifies the frame modulo 10 (phase ≡ 10 − i mod 10).
    const phase = async (i) => {
      const b = await app.fmv.frameBitmap(clip, i);
      const c = new OffscreenCanvas(b.width, b.height);
      const g = c.getContext('2d');
      g.drawImage(b, 0, 0);
      const d = g.getImageData(0, 4, 320, 1).data;
      const s = Array.from({ length: 80 }, (_, k) => d[4 * 4 * k] > 128);
      for (let k = 0; k < 80; k++) if (s[k] && !s[(k + 79) % 80]) return k % 10;
      return -1;
    };
    v.seekFrame(100);
    await v.step(1);
    const stepped = { frame: v.frame, still: v.still?.frame ?? null, phase: await phase(v.frame), want: (((10 - v.frame) % 10) + 10) % 10 };
    await v.step(-1);
    await v.step(-1);
    const back = { frame: v.frame, phase: await phase(v.frame), want: (((10 - v.frame) % 10) + 10) % 10 };
    const phases = [];
    for (const i of [0, 1, 2, 3, 45, 255, 299]) phases.push([i, await phase(i).catch(() => -2), (((10 - i) % 10) + 10) % 10]);
    // Rate and A–B loop.
    v.setRate(2);
    v.setLoop({ a: 30, b: 60, on: true });
    v.seekFrame(30);
    app.fmv.sync.history.length = 0;
    v.play();
    await sleep(2500);
    v.pause();
    const seen = app.fmv.sync.history.map((x) => x.video);
    v.setLoop({ on: false });
    v.setRate(1);
    // HUD blocks: drawn, draggable (layout in prefs), hideable.
    const lines = app.fmv.hudLines(clip, app.fmv.stateAt(clip, v.frame), 'time');
    app.prefs.set('fmvHud', { sensor: { hidden: true } });
    v.drawHud();
    const boxes = v._hudBoxes.map((b) => b.id);
    app.prefs.set('fmvHud', {});
    return { worst, n: hist.length, advanced, stepped, back, phases, loopMin: Math.min(...seen), loopMax: Math.max(...seen), loopN: seen.length, rate: v.video.playbackRate, lines, boxes, playing: v.playing };
  });
  expect(r.n).toBeGreaterThan(40);
  expect(r.worst).toBeLessThanOrEqual(1);
  expect(r.advanced).toBeGreaterThan(50);
  expect(r.stepped.frame).toBe(101);
  expect(r.stepped.still).toBe(101);
  expect(r.stepped.phase).toBe(r.stepped.want);
  expect(r.back.frame).toBe(99);
  expect(r.back.phase).toBe(r.back.want);
  for (const [i, got, want] of r.phases) expect(got, `frame ${i}`).toBe(want);
  expect(r.loopN).toBeGreaterThan(20);
  expect(r.loopMin).toBeGreaterThanOrEqual(29);
  expect(r.loopMax).toBeLessThanOrEqual(61);
  expect(r.lines[0]).toMatch(/UTC$/);
  expect(r.lines[1]).toMatch(/MISP→UTC/);
  expect(r.boxes).toEqual(['time', 'centre', 'geometry']);
  expect(logs).toEqual([]);
});

test('SCN-15 AT-15.4 REQ-FMV-09 FX-10 captured frames: PNG + world file + JSON; NITF reopens with corners equal to the footprint (RPC00B)', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const out = {};
  for (const file of ['fx10.ts', 'fx10_c.ts']) {
    await openFiles(frame, [TS(file)]);
    await frame.waitForFunction((n) => window.gisworkbench.fmv.activeClip()?.name === n && window.gisworkbench.fmv.viewOf(window.gisworkbench.fmv.activeClip()), file, { timeout: 60000 });
    out[file] = await frame.evaluate(async ({ DIST }) => {
      const d = eval(DIST);
      const app = window.gisworkbench;
      const clip = app.fmv.activeClip();
      app.fmv.viewOf(clip).seekFrame(150);
      const cap = await app.fmv.capture(clip, 150, { save: false });
      const png = await createImageBitmap(cap.png);
      const pgw = (await cap.pgw.text()).trim().split('\n').map(Number);
      const meta = JSON.parse(await cap.json.text());
      // Reopen the NITF in another panel.
      app.desktop.multiports[0].setLayout('1x2');
      const p2 = app.desktop.multiports[0].panes.find((p) => !p.video);
      const file = new File([cap.nitf], cap.nitfName);
      await app.openFiles([file], p2);
      const l = [...app.layers.values()].find((x) => x.info.fileName === cap.nitfName);
      const W = l.width;
      const H = l.height;
      const h0 = app.fmv.stateAt(clip, 150).fcHae;
      const byModel = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => {
        const g = app.core.i2g(l.modelId, x, y, h0);
        return [g.lat, g.lon];
      });
      const err = Math.max(...byModel.map((c, q) => d(c, cap.footprint[q])));
      const ig = l.info.subheader?.IGEOLO ?? '';
      const r = { png: [png.width, png.height], pgw, metaKeys: Object.keys(meta), klvN: meta.klv.length, source: cap.source, rpcFit: cap.rpcFit, model: l.modelName, err, igeolo: ig, nitfCorners: cap.nitfCorners, marking: l.info.marking?.level ?? null };
      // Back to one panel for the next clip.
      await app.fmv.closeVideo(app.fmv.viewOf(clip).pane);
      app.desktop.multiports[0].setLayout('1x1');
      for (const x of [...app.layers.values()]) app.removeLayer?.(x.id);
      return r;
    }, { DIST });
  }
  for (const [file, r] of Object.entries(out)) {
    expect(r.png, file).toEqual([640, 360]);
    expect(r.pgw.length, file).toBe(6);
    expect(r.metaKeys).toEqual(expect.arrayContaining(['footprint', 'klv', 'utc', 'timeBasis', 'precisionTimeUs']));
    expect(r.klvN).toBeGreaterThan(15);
    expect(r.model, file).toMatch(/RPC/);
    expect(r.rpcFit.rmsPx, file).toBeLessThan(0.05);
    expect(r.err, `${file} reopened corners vs footprint (m)`).toBeLessThan(1);
    expect(r.igeolo.length).toBe(60);
  }
  expect(out['fx10.ts'].rpcFit.model).toMatch(/projective/);
  expect(out['fx10_c.ts'].rpcFit.model).toMatch(/KLV frame model/);
  expect(logs).toEqual([]);
});

test('SCN-15 AT-15.5 REQ-FMV-11 FX-11 STANAG 4607 targets plot within 1 m and filter by time on the video time slider', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [TS('fx10.ts'), resolve(D11, 'fx11.4607')]);
  await clipOpen(frame);
  await frame.waitForFunction(() => window.gisworkbench.fmv.gmti.length === 1, null, { timeout: 30000 });
  const r = await frame.evaluate(async ({ DIST, gt }) => {
    const d = eval(DIST);
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    const g = app.fmv.gmti[0];
    const at = async (i, win) => {
      app.fmv.options.gmtiWindowS = win;
      v.seekFrame(i);
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const vis = app.fmv.gmtiVisible();
      return { dwells: [...new Set(vis.map((t) => t.dwell))].sort((a, b) => a - b), n: vis.length, mapN: app.fmv.lastMap.targets.length };
    };
    const f0 = await at(0, 2);
    const f150 = await at(150, 2);
    const f150narrow = await at(150, 0.5);
    // Positions: dwell 10 (the clip start) against the truth.
    const d10 = g.data.dwells.find((x) => x.dwell === 10);
    const err = Math.max(...d10.targets.map((t, k) => d([t.lat, t.lon], [gt.dwells[10].targets[k].lat, gt.dwells[10].targets[k].lon])));
    const vel = d10.targets.map((t, k) => Math.abs(t.v - gt.dwells[10].targets[k].vlos));
    // Filters: speed and class.
    app.fmv.options.gmtiWindowS = 2;
    app.fmv.options.gmtiClasses = [1];
    const cls = app.fmv.gmtiVisible().every((t) => t.class === 1);
    app.fmv.options.gmtiClasses = null;
    app.fmv.options.gmtiMinSpeed = 100;
    const none = app.fmv.gmtiVisible().length;
    app.fmv.options.gmtiMinSpeed = 0;
    app.commands.run('fmv.gmticolour');
    const colour = app.fmv.options.gmtiColour;
    return { f0, f150, f150narrow, err, vel: Math.max(...vel), cls, none, colour, header: g.data.header.classificationText, jobs: g.data.jobs.length, platform: g.data.platform.length, hint: clip.basisHint };
  }, { DIST, gt: gtruth });
  expect(r.f0.dwells).toEqual([7, 8, 9, 10]);
  expect(r.f0.n).toBe(24);
  expect(r.f0.mapN).toBe(24);
  expect(r.f150.dwells).toEqual([17, 18, 19, 20]);
  expect(r.f150narrow.dwells).toEqual([20]);
  expect(r.err).toBeLessThan(1);
  expect(r.vel).toBeLessThan(0.011);
  expect(r.cls).toBe(true);
  expect(r.none).toBe(0);
  expect(r.colour).toBe('velocity');
  expect(r.header).toBe('UNCLASSIFIED');
  expect(r.jobs).toBe(1);
  expect(r.platform).toBe(30);
  // FX-11 overlaps the clip under the default MISP basis, so GMTI raises no legacy-UTC hint.
  expect(r.hint ?? '').not.toMatch(/GMTI/);
  expect(logs).toEqual([]);
});

test('SCN-15 REQ-FMV-10 REQ-FMV-12 REQ-FMV-13 REQ-FMV-14 FX-10 event log on the map; VMTI boxes and locations; metadata-only mode; CSV metadata; 4676 tracks; mensuration; linked panels', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [TS('fx10_b.ts')]);
  await clipOpen(frame);
  const r = await frame.evaluate(async ({ DIST, vm, fc }) => {
    const d = eval(DIST);
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    // VMTI (fx10_b frame 40).
    v.seekFrame(40);
    await raf();
    const st = app.fmv.stateAt(clip, 40);
    const boxes = st.vmti.targets.map((t) => t.box);
    const locErr = Math.max(...st.vmti.targets.map((t, k) => d([t.loc[0], t.loc[1]], [vm[k].lat, vm[k].lon])));
    const mapVmti = app.fmv.lastMap.vmti.length;
    // Event log.
    v.seekFrame(90);
    const ev = await app.fmv.addEvent(clip, { text: 'vehicle turns', tag: 'vehicle' });
    await raf();
    const events = app.fmv.lastMap.events;
    const csv = app.fmv.eventsAs('csv');
    const gj = JSON.parse(app.fmv.eventsAs('geojson'));
    const kml = app.fmv.eventsAs('kml');
    // Mensuration on the paused frame: two clicks → a distance from the KLV frame model.
    const cr = v.contentRect();
    app.fmv.measureMode = true;
    app.fmv.measureClick(v, cr.x + 100 * cr.scale, cr.y + 180 * cr.scale);
    app.fmv.measureClick(v, cr.x + 540 * cr.scale, cr.y + 180 * cr.scale);
    app.fmv.measureMode = false;
    const meas = v.measure.result;
    // STANAG 4676 tracks (tolerant XML reader).
    const xml = `<?xml version="1.0"?><TrackMessage xmlns="urn:nato:stanag:4676:isrtrackingstandard:b"><track><trackNumber>T-7</trackNumber>${[0, 1, 2].map((k) => `<item><trackPoint><time>2025-10-25T23:59:3${1 + k}Z</time><latitude>${-34.51 + k * 1e-4}</latitude><longitude>-58.594</longitude></trackPoint></item>`).join('')}</track></TrackMessage>`;
    const tr = await app.fmv.openTracks4676(new File([xml], 'tracks.4676.xml'));
    return { boxes, locErr, mapVmti, ev: { lat: ev.lat, lon: ev.lon, utc: ev.utc, thumb: !!ev.thumbnail, frame: ev.frame }, events, csvOk: csv.includes('vehicle turns'), gj: gj.features.length, kml: kml.includes('<Placemark>'), meas, tr, fc };
  }, { DIST, vm: truth.frames[40].vmti, fc: truth.frames[90].frame_center });

  expect(r.locErr).toBeLessThan(1);
  expect(r.mapVmti).toBe(2);
  expect(r.ev.frame).toBe(91);
  // The event sits at the frame centre of frame 91 (index 90).
  expect(Math.abs(r.ev.lat - r.fc.lat)).toBeLessThan(2e-6);
  expect(r.ev.thumb).toBe(true);
  expect(r.events).toBe(1);
  expect(r.csvOk && r.kml).toBe(true);
  expect(r.gj).toBe(1);
  expect(r.meas.label).toMatch(/KLV frame model/);
  expect(r.meas.distanceM).toBeGreaterThan(50);
  expect(r.tr).toEqual({ tracks: 1, points: 3 });
  // VMTI boxes against the truth (bounding-box pixel numbers are inclusive corners).
  const t40 = truth.frames[40].vmti;
  expect(r.boxes).toEqual(t40.map((t) => [t.box[0], t.box[1], t.box[2] + 1, t.box[3] + 1]));

  // Metadata-only mode (REQ-FMV-05): an unplayable codec keeps the KLV, map and footprints.
  const m = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const orig = MediaSource.isTypeSupported;
    MediaSource.isTypeSupported = () => false;
    try {
      const resp = await fetch(app.fmv.activeClip().url);
      const f = new File([await resp.blob()], 'fx10_meta.ts');
      await app.fmv.open(f);
    } finally {
      MediaSource.isTypeSupported = orig;
    }
    const clip = app.fmv.activeClip();
    const v = app.fmv.viewOf(clip);
    v.play();
    await new Promise((res) => setTimeout(res, 700));
    v.pause();
    return { meta: v.metadataOnly, msg: v.msg.textContent, frame: v.frame, fp: app.fmv.stateAt(clip, v.frame).footprint?.length };
  });
  expect(m.meta).toBe(true);
  expect(m.msg).toMatch(/metadata only/);
  expect(m.frame).toBeGreaterThan(5);
  expect(m.fp).toBe(4);

  // CSV metadata for video without KLV (REQ-FMV-14): footprints computed from the CSV angles.
  const csv = ['time,lat,lon,hae,heading,az,el,hfov,fc_hae', ...truth.frames.filter((_, i) => i % 10 === 0).map((f) => [f.t_s, f.platform.lat, f.platform.lon, f.platform.alt_hae_m, f.platform.heading_deg, f.sensor.rel_az_deg, f.sensor.rel_el_deg, f.sensor.hfov_deg, f.frame_center.h_hae_m].join(','))].join('\n');
  const c = await frame.evaluate(async ({ csv, want, DIST }) => {
    const d = eval(DIST);
    const app = window.gisworkbench;
    const clip = app.fmv.activeClip();
    const n = await app.fmv.importCsv(clip, new File([csv], 'meta.csv'));
    const st = app.fmv.stateAt(clip, 60);
    return { n, source: st.footprintSource, err: Math.max(...st.footprint.map((p, q) => d(p, want[q]))) };
  }, { csv, want: truth.frames[60].computed_corners, DIST });
  expect(c.n).toBe(30);
  expect(c.source).toMatch(/computed/);
  expect(c.err).toBeLessThan(1);

  // Linked panels (REQ-FMV-13): a second clip follows the first by UTC.
  const l = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    for (const c of [...app.fmv.clips.values()]) await app.fmv.closeVideo(app.fmv.viewOf(c).pane);
    app.desktop.multiports[0].setLayout('1x2');
    const [p1, p2] = app.desktop.multiports[0].panes;
    const urls = ['fx10.ts', 'fx10_c.ts'];
    return { panes: [p1.id, p2.id], urls };
  });
  await openFiles(frame, [TS('fx10.ts')]);
  await clipOpen(frame, 1);
  await openFiles(frame, [TS('fx10_c.ts')]);
  await clipOpen(frame, 2);
  const k = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const [a, b] = [...app.fmv.clips.values()];
    app.commands.run('fmv.link');
    const va = app.fmv.viewOf(a);
    va.seekFrame(120, 'video');
    app.fmv.setFrame(a, 120, { source: 'video', view: va });
    const vb = app.fmv.viewOf(b);
    return { a: va.frame, b: vb.frame, panes: [va.pane.id, vb.pane.id] };
  });
  expect(l.panes.length).toBe(2);
  expect(k.panes[0]).not.toBe(k.panes[1]);
  expect(Math.abs(k.b - k.a)).toBeLessThanOrEqual(1);
  expect(logs).toEqual([]);
});
