// R1 comparison (REQ-IMG-24, AT-11.1/2): the same chip twice in one panel, the upper copy
// inverted, so every mode has an exact pixel expectation: porthole, swiper, blend, flicker
// and two-colour (date 1 red, date 2 cyan) with its legend; WebM recording (REQ-IMG-25).
import { test, expect } from '@playwright/test';
import { openApp, openFiles, sample } from './helpers.js';

async function ready(page) {
  const { frame, logs } = await openApp(page, 'file');
  const chip = sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf');
  await openFiles(frame, [chip]);
  await openFiles(frame, [chip]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].length === 2 && [...window.gisworkbench.layers.values()].every((l) => l.lutTex && !l.tiles.loading));
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const [lo, up] = p.layers();
    // Same chain on both (DRA locked) and the upper copy inverted.
    app.setChain((c) => (c.tone.invert = true), 'Invert', { layerId: up.id });
    app.store.transact('active', (tx) => tx.set(p.id, 'activeLayer', up.id));
    p.setView({ cx: 768, cy: 768, zoom: 0.5, rot: 0, mode: 'native' });
  });
  return { frame, logs };
}

/** Grey values at three screen points of the pane, in page px offsets from its left/top. */
const sampleAt = (frame, pts) =>
  frame.evaluate(async (pts) => {
    await new Promise((r) => setTimeout(r, 300));
    const app = window.gisworkbench;
    const cap = app.renderer.capture();
    const b = app.activePane().el.getBoundingClientRect();
    return pts.map(([fx, fy]) => {
      const x = Math.round((b.left + fx * b.width) * cap.dpr);
      const y = Math.round((b.top + fy * b.height) * cap.dpr);
      const i = (y * cap.width + x) * 4;
      return [cap.data[i], cap.data[i + 1], cap.data[i + 2]];
    });
  }, pts);

test('REQ-IMG-24 porthole, swiper, blend, flicker and two-colour draw the expected pixels', async ({ page }) => {
  const { frame, logs } = await ready(page);
  const P = [[0.3, 0.5], [0.5, 0.5], [0.7, 0.5]];
  // Reference: lower (plain) and upper (inverted) alone.
  await frame.evaluate(() => {
    const p = window.gisworkbench.activePane();
    window.gisworkbench.store.transact('t', (tx) => tx.set(p.layers()[1].id, 'visible', false));
  });
  const plain = await sampleAt(frame, P);
  await frame.evaluate(() => {
    const p = window.gisworkbench.activePane();
    window.gisworkbench.store.transact('t', (tx) => tx.set(p.layers()[1].id, 'visible', true));
  });
  const inv = await sampleAt(frame, P);
  for (let i = 0; i < 3; i++) expect(Math.abs(plain[i][0] + inv[i][0] - 255)).toBeLessThanOrEqual(2);

  const box = await frame.evaluate(() => window.gisworkbench.activePane().el.getBoundingClientRect().toJSON());
  const run = (cmd) => frame.evaluate((c) => window.gisworkbench.commands.run(c), cmd);
  // Porthole at the centre: the lower image inside the hole, the upper outside.
  await run('cmp.porthole');
  await page.mouse.move(box.left + box.width * 0.5, box.top + box.height * 0.5);
  let s = await sampleAt(frame, P);
  expect(Math.abs(s[1][0] - plain[1][0])).toBeLessThanOrEqual(2);
  expect(Math.abs(s[0][0] - inv[0][0])).toBeLessThanOrEqual(2);
  await run('cmp.porthole');
  // Swiper at 60 %: upper image left of the line.
  await run('cmp.swiper');
  await page.mouse.move(box.left + box.width * 0.6, box.top + box.height * 0.2);
  s = await sampleAt(frame, P);
  expect(Math.abs(s[0][0] - inv[0][0])).toBeLessThanOrEqual(2);
  expect(Math.abs(s[2][0] - plain[2][0])).toBeLessThanOrEqual(2);
  await run('cmp.swiper');
  // Blend 50 %: the mean of the two.
  await run('cmp.blend');
  s = await sampleAt(frame, P);
  for (let i = 0; i < 3; i++) expect(Math.abs(s[i][0] - (plain[i][0] + inv[i][0]) / 2)).toBeLessThanOrEqual(3);
  await run('cmp.blend');
  // Two-colour: red from date 1 (lower), green and blue from date 2 (upper).
  await run('cmp.twocolour');
  s = await sampleAt(frame, P);
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(s[i][0] - plain[i][0])).toBeLessThanOrEqual(2);
    expect(Math.abs(s[i][1] - inv[i][0])).toBeLessThanOrEqual(2);
    expect(Math.abs(s[i][2] - inv[i][0])).toBeLessThanOrEqual(2);
  }
  const legend = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const g = p.overlay.getContext('2d');
    const seen = [];
    const o = g.fillText.bind(g);
    g.fillText = (t, ...a) => (seen.push(t), o(t, ...a));
    p.invalidate();
    await new Promise((r) => setTimeout(r, 200));
    g.fillText = o;
    return seen;
  });
  expect(legend.some((t) => /^Date 1: .*2015-12-18 14:04:55Z$/.test(t))).toBe(true);
  expect(legend.some((t) => /^Date 2: /.test(t))).toBe(true);
  await run('cmp.twocolour');
  // Flicker: both images appear over time, and the panel animates.
  await run('cmp.play');
  const seen = new Set();
  for (let k = 0; k < 10; k++) {
    const v = await sampleAt(frame, [[0.5, 0.5]]);
    seen.add(Math.abs(v[0][0] - plain[1][0]) <= 2 ? 'lower' : Math.abs(v[0][0] - inv[1][0]) <= 2 ? 'upper' : 'other');
  }
  expect(seen.has('lower') && seen.has('upper')).toBe(true);
  expect(await frame.evaluate(() => window.gisworkbench.activePane().animating())).toBe(true);
  await run('cmp.play');
  expect(logs).toEqual([]);
});

test('AT-11.1 swipe and porthole render a 2k viewport at ≥ 30 fps', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  const { frame } = await ready(page);
  for (const mode of ['cmp.swiper', 'cmp.porthole']) {
    const fps = await frame.evaluate(async (cmd) => {
      const app = window.gisworkbench;
      app.commands.run(cmd);
      const p = app.activePane();
      p.setView({ zoom: 1 });
      const r = p.el.getBoundingClientRect();
      let n = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 1500) {
        const x = r.left + ((n * 37) % r.width);
        p.el.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: r.top + r.height / 2, bubbles: true }));
        await new Promise((res) => requestAnimationFrame(res));
        n++;
      }
      app.commands.run(cmd);
      return n / ((performance.now() - t0) / 1000);
    }, mode);
    expect(fps, mode).toBeGreaterThanOrEqual(30);
  }
});

for (const fmt of ['webm', 'gif']) {
  test(`REQ-IMG-25 recording the flicker produces a ${fmt.toUpperCase()} file that the browser decodes`, async ({ page }) => {
    const { frame } = await ready(page);
    await frame.evaluate((f) => {
      Object.assign(window.gisworkbench.runMode.caps, { fsaSave: false });
      window.gisworkbench.prefs.set('recordFormat', f);
      window.gisworkbench.commands.run('cmp.play');
      window.gisworkbench.commands.run('cmp.record');
    }, fmt);
    await page.waitForTimeout(1500);
    const [dl] = await Promise.all([page.waitForEvent('download'), frame.evaluate(() => window.gisworkbench.commands.run('cmp.record'))]);
    expect(dl.suggestedFilename().endsWith(`.${fmt}`)).toBe(true);
    const buf = await (await import('node:fs')).promises.readFile(await dl.path());
    expect(buf.length).toBeGreaterThan(2000);
    if (fmt === 'webm') expect(buf.subarray(0, 4).toString('hex')).toBe('1a45dfa3'); // EBML
    else expect(buf.subarray(0, 6).toString()).toBe('GIF89a');
    // The browser decodes it: GIF frames through ImageDecoder, WebM through a <video>.
    const ok = await frame.evaluate(async ({ b64, fmt }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      if (fmt === 'gif') {
        const d = new ImageDecoder({ data: bytes, type: 'image/gif' });
        await d.tracks.ready;
        const frames = d.tracks.selectedTrack.frameCount;
        const { image } = await d.decode({ frameIndex: Math.min(3, frames - 1) });
        const c = new OffscreenCanvas(image.displayWidth, image.displayHeight);
        c.getContext('2d').drawImage(image, 0, 0);
        const px = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
        return { frames, w: image.displayWidth, lit: px[0] + px[1] + px[2] > 0 };
      }
      const v = document.createElement('video');
      v.muted = true;
      v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
      await new Promise((res, rej) => {
        v.onloadeddata = res;
        v.onerror = () => rej(new Error(`video error ${v.error?.code}`));
      });
      return { frames: 1, w: v.videoWidth, lit: v.videoHeight > 0 };
    }, { b64: buf.toString('base64'), fmt });
    expect(ok.w).toBeGreaterThan(100);
    expect(ok.lit).toBe(true);
    if (fmt === 'gif') expect(ok.frames).toBeGreaterThan(5);
  });
}
