// R1 navigation: magnifier, overview and panel-in-panel (REQ-IMG-14), bookmarks
// (REQ-IMG-13), Link Manager geo-link with chain (REQ-IMG-15, AT-02.1), map grids and
// azimuth arrows (REQ-IMG-22, AT-16.2), window commands (REQ-UI-02) and online map
// backgrounds through the allow-list (REQ-UI-26, REQ-ARC-16).
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { openApp, openFiles, sample } from './helpers.js';

const CHIP = () => sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf');

async function ready(page, files = [CHIP()]) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, files);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].every((l) => l.lutTex && !l.tiles.loading));
  return { frame, logs };
}

test('REQ-IMG-14 magnifier, overview dock and panel-in-panel', async ({ page }) => {
  const { frame, logs } = await ready(page);
  await frame.evaluate(() => window.gisworkbench.commands.run('nav.magnifier'));
  const r = await frame.evaluate(() => window.gisworkbench.activePane().el.getBoundingClientRect().toJSON());
  await page.mouse.move(r.left + r.width / 2, r.top + r.height / 2);
  await page.mouse.move(r.left + r.width / 2 + 5, r.top + r.height / 2 + 5);
  await frame.locator('.multiport .pane').first().focus();
  await page.keyboard.press('ArrowUp');
  const mag = await frame.evaluate(() => ({ ...window.gisworkbench.magnifier }));
  expect(mag.on).toBe(true);
  expect(mag.power).toBe(8);
  // The lens shows image pixels (not the cleared black) at its centre.
  const lens = await frame.evaluate(async () => {
    await new Promise((res) => setTimeout(res, 300));
    const app = window.gisworkbench;
    const p = app.activePane();
    const lr = p.lensRect();
    const cap = app.renderer.capture();
    const b = p.el.getBoundingClientRect();
    let lit = 0;
    for (let i = 0; i < 40; i++) {
      const x = Math.round((b.left + lr.x + 20 + i * 3) * cap.dpr);
      const y = Math.round((b.top + lr.y + lr.s / 2 + 7) * cap.dpr);
      if (cap.data[(y * cap.width + x) * 4] > 8) lit++;
    }
    return { lr, lit };
  });
  expect(lens.lr.s).toBe(200);
  expect(lens.lit).toBeGreaterThan(20);
  await frame.evaluate(() => window.gisworkbench.commands.run('nav.magnifier'));

  // Overview dock (copied pixels) and click-to-recentre.
  await frame.evaluate(() => window.gisworkbench.commands.run('ov.open'));
  const ov = frame.locator('.minipane-dock');
  await expect(ov).toBeVisible();
  await page.waitForTimeout(500);
  const lit = await ov.locator('canvas').evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 40) if (d[i] > 30) n++;
    return n;
  });
  expect(lit).toBeGreaterThan(500);
  const before = await frame.evaluate(() => ({ ...window.gisworkbench.activePane().view }));
  const ob = await ov.boundingBox();
  await page.mouse.click(ob.x + ob.width * 0.25, ob.y + ob.height * 0.25);
  const after = await frame.evaluate(() => ({ ...window.gisworkbench.activePane().view }));
  expect(after.cx).toBeLessThan(before.cx - 100);
  expect(after.cy).toBeLessThan(before.cy - 100);
  // Panel-in-panel.
  await frame.evaluate(() => window.gisworkbench.commands.run('ov.pip'));
  await expect(frame.locator('.pane .minipane-pip')).toHaveCount(1);
  expect(logs).toEqual([]);
});

test('REQ-IMG-13 bookmarks return to the stored ground centre and scale', async ({ page }) => {
  const { frame } = await ready(page);
  await frame.evaluate(() => {
    const p = window.gisworkbench.activePane();
    p.setView({ cx: 400, cy: 900, zoom: 1.3 });
  });
  await frame.evaluate(() => void window.gisworkbench.commands.run('bm.add'));
  await frame.locator('.dlg input').fill('Parking lot');
  await frame.locator('.dlg').getByRole('button', { name: 'OK' }).click();
  await frame.evaluate(() => window.gisworkbench.activePane().setView({ cx: 1200, cy: 200, zoom: 0.4 }));
  await frame.evaluate(() => void window.gisworkbench.commands.run('bm.list'));
  await expect(frame.locator('[data-id="dialog:bookmarks"]')).toContainText('Parking lot');
  await frame.locator('[data-id="dialog:bookmarks"]').getByRole('button', { name: 'Go' }).click();
  const v = await frame.evaluate(() => ({ ...window.gisworkbench.activePane().view }));
  expect(Math.abs(v.cx - 400)).toBeLessThan(0.5);
  expect(Math.abs(v.cy - 900)).toBeLessThan(0.5);
  expect(Math.abs(v.zoom - 1.3) / 1.3).toBeLessThan(0.01);
  // Bookmarks are project records (saved with the project, undoable).
  expect(await frame.evaluate(() => window.gisworkbench.store.all('bookmark').length)).toBe(1);
});

test('AT-02.1 REQ-IMG-15 geo-linked panes stay within 1 screen pixel; chain link copies the chain', async ({ page }) => {
  const { frame } = await ready(page);
  // A second panel with the other WV3 chip (different sensor geometry).
  await frame.evaluate(() => window.gisworkbench.activeMp().setLayout('1x2'));
  await frame.evaluate(() => {
    const mp = window.gisworkbench.activeMp();
    mp.setActivePane(mp.panes[1]);
  });
  await openFiles(frame, [sample('nitf-wv3-mvs-stereo-chips', 'wv3_b_chip.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].every((l) => l.lutTex));
  await frame.evaluate(() => {
    const mp = window.gisworkbench.activeMp();
    mp.setActivePane(mp.panes[0]);
  });
  await frame.evaluate(() => void window.gisworkbench.commands.run('link.manager'));
  const dlg = frame.locator('[data-id="dialog:link-manager"]');
  const selects = dlg.locator('select[aria-label^="Link group of"]');
  await selects.nth(0).selectOption('A');
  await selects.nth(1).selectOption('A');
  await dlg.getByLabel('Group A: link chain').check();
  await dlg.getByRole('button', { name: 'OK' }).click();
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const [a, b] = app.activeMp().panes;
    a.setView({ cx: 700, cy: 800, zoom: 1.7 });
    const la = a.geoLayer();
    const lb = b.geoLayer();
    const out = [];
    // Several points across pane A: their ground positions land on the same screen spot in B.
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.4], [0.7, 0.6]]) {
      const { w, h } = a.size();
      const ip = a.imagePoint(fx * w, fy * h);
      const g = la.groundAt(ip.x, ip.y);
      const q = lb.imageAt(g.lat, g.lon, g.h);
      const sb = b.screenPoint(q.x, q.y);
      const { w: w2, h: h2 } = b.size();
      out.push([sb.x - fx * w2, sb.y - fy * h2]);
    }
    return { centre: out[0], scaleA: a.groundScale(), scaleB: b.groundScale() };
  });
  expect(Math.hypot(...r.centre)).toBeLessThan(1);
  expect(Math.abs(r.scaleA - r.scaleB) / r.scaleA).toBeLessThan(0.01);
  await frame.evaluate(() => window.gisworkbench.setChain((c) => (c.tone.gamma = 40), 'Gamma'));
  const g2 = await frame.evaluate(() => window.gisworkbench.activeMp().panes[1].activeLayer().chain.tone.gamma);
  expect(g2).toBe(40);
});

test('REQ-IMG-22 AT-16.2 grids, sun and sensor arrows; REQ-UI-02 tabbed, clone and separate', async ({ page }) => {
  const { frame } = await ready(page);
  const texts = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const seen = [];
    const g = p.overlay.getContext('2d');
    const orig = g.fillText.bind(g);
    g.fillText = (t, ...a) => {
      seen.push(String(t));
      return orig(t, ...a);
    };
    app.prefs.set('grid', { type: 'mgrs', last: 'mgrs', colour: '#00e5ff', labels: true, interval: 0 });
    app.prefs.set('decorations', { sun: true, sensor: true });
    p.invalidate();
    await new Promise((r) => setTimeout(r, 300));
    app.prefs.set('grid', { type: 'latlon', last: 'latlon', colour: '#00e5ff', labels: true, interval: 0 });
    p.invalidate();
    await new Promise((r) => setTimeout(r, 300));
    g.fillText = orig;
    return seen;
  });
  // MGRS grid labels carry the 100 km square ID; truth: the chip lies in 21H UB.
  expect(texts.some((t) => /^UB \d+$/.test(t))).toBe(true);
  expect(texts.some((t) => /^MGRS 21$/.test(t))).toBe(true);
  expect(texts.some((t) => /^34°29′\d\d″S$|^58°35′\d\d″W$/.test(t))).toBe(true);
  // Sun angles from USE00A (truth 071.708 / +64.451); sensor azimuth from the model (truth 048.8°).
  expect(texts.some((t) => t === 'Sun 72° el 64°' || t === 'Sun 72° el 65°')).toBe(true);
  expect(texts.some((t) => /^Sensor 49° el 6\d°$/.test(t))).toBe(true);

  await frame.evaluate(() => window.gisworkbench.activeMp().setLayout('2x2'));
  await frame.evaluate(() => window.gisworkbench.commands.run('win.tabbed'));
  await expect(frame.locator('.panel-tab')).toHaveCount(4);
  await expect(frame.locator('.multiport .panel-grid > .pane')).toHaveCount(1);
  await frame.locator('.panel-tab').nth(2).click();
  expect(await frame.evaluate(() => window.gisworkbench.activeMp().panes.indexOf(window.gisworkbench.activeMp().activePane))).toBe(2);
  await frame.evaluate(() => window.gisworkbench.commands.run('win.tabbed'));
  await frame.evaluate(() => window.gisworkbench.commands.run('win.clone'));
  await frame.waitForFunction(() => window.gisworkbench.desktop.multiports.length === 2 && window.gisworkbench.desktop.multiports[1].panes[0].layers()[0]?.lutTex);
  const n = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.desktop.activeMp = app.desktop.multiports[0];
    await app.commands.run('win.separate');
    return app.desktop.multiports.map((m) => m.panes.length);
  });
  expect(n).toEqual([3, 4, 1]);
});

/** A 256×256 solid-colour PNG (uncompressed scanlines, zlib) for the tile server. */
function png(r, g, b) {
  const w = 256;
  const raw = Buffer.alloc((w * 3 + 1) * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('REQ-UI-26 REQ-ARC-16 an online background draws only after its origin is allowed (add → save copy → reload)', async ({ page }) => {
  const tile = png(200, 30, 160);
  let hits = 0;
  const srv = createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' });
    res.end(tile);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  try {
    const { frame } = await openApp(page, 'file');
    const html = await frame.evaluate((o) => window.gisworkbench.__test.htmlWithOrigins([o]), origin);
    const dir = join(tmpdir(), 'gw-online');
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, 'gis-workbench-online.html');
    writeFileSync(copy, html);
    const page2 = await page.context().newPage();
    const { frame: f2, logs } = await openApp(page2, 'file', { htmlPath: copy });
    const px = await f2.evaluate(async (o) => {
      const app = window.gisworkbench;
      app.online.sources = [{ id: 'local', name: 'Local tiles', url: `${o}/{z}/{x}/{y}.png`, attribution: 'test tiles', maxZoom: 19 }];
      app.online.active = 'local';
      app.online.visible = true;
      app.online.save();
      app.desktop.workspace.map.zoomTo(10, 10, 4);
      for (let i = 0; i < 60 && !app.onlineTiles.cache.size; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 300));
      const cap = app.renderer.capture();
      const b = app.desktop.workspace.map.el.getBoundingClientRect();
      const x = Math.round((b.left + b.width / 2) * cap.dpr);
      const y = Math.round((b.top + b.height / 2) * cap.dpr);
      const i = (y * cap.width + x) * 4;
      return { rgb: [cap.data[i], cap.data[i + 1], cap.data[i + 2]], log: app.netlog.entries.filter((e) => e.origin === o).length, att: document.querySelector('.map-attribution').textContent };
    }, origin);
    expect(hits).toBeGreaterThan(0);
    expect(px.log).toBeGreaterThan(0);
    expect(px.att).toBe('test tiles');
    expect(px.rgb[0]).toBeGreaterThan(150);
    expect(px.rgb[1]).toBeLessThan(80);
    expect(logs).toEqual([]);
    await page2.close();
  } finally {
    srv.close();
  }
});
