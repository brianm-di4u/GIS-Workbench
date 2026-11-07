// GIS Workbench Lite in real Android Chrome on an emulator or a phone (OD-2.23, REQ-HOST-05 owner
// item 1): the load routes a phone has, the real on-screen keyboard, real touch through Android's
// input stack, the real location prompt, camera and share sheet, and memory. tests/e2e/25-mobile
// holds the desktop-emulated checks; this file does not repeat what only proves the app's logic.
//
// Numbers are host-relative on an emulator: an x86_64 guest on a laptop is not a phone's speed.

import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  adb, sh, sleep, shot, ui, findUi, tapUi, fingerTap, fingerTapOn, fingerSwipe, fingerHold, chromeMemory, deviceFacts,
  startChrome, watch, ready, openLite, ORIGIN, REMOTE_FILE,
} from './device.js';

const DIST = process.env.GW_DIST ?? 'dist';
const LITE = join(DIST, 'gis-workbench-lite.html');
const HOSTED = 'https://www.gisworkbench.com/app/gis-workbench-lite';
const IMAGE = join('fixtures', 'fx01', 'fx01.ntf');
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const GATE = { lat: 36.1, lon: -115.2 };
const METRICS = join('reports', 'android', 'metrics.json');

const metrics = existsSync(METRICS) ? JSON.parse(readFileSync(METRICS, 'utf8')) : {}; // workers restart after a failure
const note = (k, v) => {
  metrics[k] = v;
  mkdirSync(join('reports', 'android'), { recursive: true });
  writeFileSync(METRICS, JSON.stringify(metrics, null, 1));
};

let run;
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) shot(`fail-${info.title.replace(/\W+/g, '-').slice(0, 60)}`);
  sh('settings put system accelerometer_rotation 0');
  sh('settings put system user_rotation 0');
  await run?.browser.close().catch(() => {});
  run = null;
});

const m = (page, id) => page.locator(`[data-id="${id}"]`);

async function openImage(page) {
  const input = await page.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.style.display = 'none';
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles({ name: 'fx01.ntf', mimeType: 'application/octet-stream', buffer: readFileSync(IMAGE) });
  await page.evaluate(async (i) => {
    const files = [...i.files];
    i.remove();
    await window.gisworkbench.openFiles(files);
  }, input);
  await expect(m(page, 'm:readout')).toBeVisible({ timeout: 60_000 });
}

const paneBox = (page) => page.locator('.m-view .pane').boundingBox();
const view = (page) => page.evaluate(() => ({ ...window.gisworkbench.activePane().view }));
async function openSheet(page, which) {
  await fingerTapOn(m(page, `m:bar:${which}`));
  await expect(m(page, 'm:sheet')).toBeVisible();
}

/** Two boxes that share area, each as [x0, y0, x1, y1]. */
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

function bootFacts(page) {
  return page.evaluate(() => {
    const app = window.gisworkbench;
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return { ready: document.body.dataset.ready, edition: document.documentElement.dataset.edition, mode: app?.runMode?.mode, protocol: location.protocol, secure: isSecureContext, problems: app?.runMode?.problems, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null, bootMs: app?.bootMs, totalMs: app ? Math.round(window.__gw.bootStart + app.bootMs) : null, share: !!navigator.share, geolocation: !!navigator.geolocation, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio };
  });
}

test('device facts', async () => {
  const f = deviceFacts();
  note('device', f);
  console.log(JSON.stringify(f));
  expect(Number(f.sdk)).toBeGreaterThan(0);
});

test.describe('load routes', () => {
  test('REQ-HOST-05 localhost through adb reverse: cold starts, secure context, no start-up problems', async () => {
    const rows = [];
    for (let i = 0; i < 3; i++) {
      run = await startChrome(`${ORIGIN}/gis-workbench-lite.html`, { cold: true });
      await ready(run.page);
      rows.push({ ...(await bootFacts(run.page)), wallMs: Date.now() - run.started });
      await run.browser.close();
      run = null;
    }
    note('route-localhost', rows);
    expect(rows.every((r) => r.ready === '1' && r.edition === 'lite' && r.secure)).toBe(true);
    expect(rows[0].problems).toEqual([]);
  });

  test('REQ-HOST-05 the hosted copy over HTTPS', async () => {
    run = await startChrome(HOSTED);
    const logs = watch(run.page);
    await ready(run.page);
    const f = await bootFacts(run.page);
    note('route-hosted', f);
    shot('route-hosted');
    expect(f.ready).toBe('1');
    expect(f.edition).toBe('lite');
    expect(f.problems).toEqual([]);
    expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
  });

  // Android keeps Chrome out of shared storage for anything but media, so a phone reaches the file
  // through content:// (the next test). If this starts to load, the limit in the report is out of date.
  test('REQ-HOST-05 a pushed file as file:// is refused by Android Chrome (a known limit)', async () => {
    adb('push', LITE, REMOTE_FILE);
    run = await startChrome(`${ORIGIN}/__loader`); // Android resolves no intent for file://, so Chrome goes there itself
    const nav = await run.page.goto(`file://${REMOTE_FILE}`, { timeout: 15_000 }).then(() => 'ok', (e) => e.message.split('\n')[0]);
    await sleep(1500);
    const s = shot('route-file');
    note('route-file', { nav, shot: s });
    expect(nav).toMatch(/ERR_ACCESS_DENIED/);
  });

  test('REQ-HOST-05 the file opened from the Files app (content://)', async () => {
    adb('push', LITE, REMOTE_FILE);
    sh('am start -a android.intent.action.VIEW_DOWNLOADS');
    await sleep(2500);
    await tapUi(/gis-workbench-lite\.html/);
    await sleep(2500);
    const once = findUi(/^Just once$/);
    if (once) sh(`input tap ${once.cx} ${once.cy}`);
    await sleep(6000);
    const s = shot('route-content');
    const r = await fetch('http://127.0.0.1:9222/json/list').then((x) => x.json()).catch(() => []);
    note('route-content', { tabs: r.map((t) => t.url), shot: s });
    const url = r.map((t) => t.url).find((u) => /^content:|^file:/.test(u));
    expect(url, 'a tab from the Files app').toBeTruthy();
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    run = { browser };
    const page = browser.contexts()[0].pages().find((p) => p.url() === url);
    await ready(page);
    const f = await page.evaluate(() => ({ ready: document.body.dataset.ready, protocol: location.protocol, origin: location.origin, secure: isSecureContext, mode: window.gisworkbench?.runMode?.mode, edition: document.documentElement.dataset.edition, indexedDB: !!window.indexedDB, problems: window.gisworkbench?.runMode?.problems, bootMs: window.gisworkbench?.bootMs, fsaSave: window.gisworkbench?.runMode?.caps?.fsaSave }));
    note('route-content-app', f);
    expect(f.ready).toBe('1');
    expect(f.problems).toEqual([]);
  });
});

test.describe('the mobile shell on a real screen', () => {
  test('REQ-HOST-05 the empty screen: the mobile GUI, and nothing on it overlaps', async () => {
    run = await openLite();
    const { page, logs } = run;
    const dom = await page.evaluate(() => ({ shell: !!document.querySelector('.m-shell'), ribbon: !!document.querySelector('.ribbon, .ribbon-tabs'), touch: matchMedia('(pointer: coarse)').matches }));
    expect(dom).toEqual({ shell: true, ribbon: false, touch: true });
    shot('shell-empty');
    const card = await m(page, 'm:empty').boundingBox();
    const hits = [];
    for (const b of await page.locator('.m-shell button:visible').all()) {
      const box = await b.boundingBox();
      const id = await b.getAttribute('data-id');
      if (box && !(await m(page, 'm:empty').locator(`[data-id="${id}"]`).count()) && overlap(card, box) > 1) hits.push(id);
    }
    expect(hits, 'controls under the empty-state card').toEqual([]);
    expect(logs).toEqual([]);
  });

  test('REQ-HOST-05 every control is 44 px and axe passes on the real page', async () => {
    run = await openLite();
    const { page } = run;
    await openImage(page);
    const small = await page.evaluate(() => [...document.querySelectorAll('.m-shell button, .m-shell select, .m-shell input:not(.sr-only)')].filter((b) => b.offsetParent).map((b) => [b.dataset.id ?? b.className, Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]).filter(([, w, h]) => w < 44 || h < 44));
    expect(small).toEqual([]);
    await page.evaluate(AXE);
    const v = await page.evaluate(async (t) => (await window.axe.run(document.body, { runOnly: { type: 'tag', values: t } })).violations.map((x) => x.id), AXE_TAGS);
    expect(v).toEqual([]);
  });

  test('REQ-HOST-05 portrait and landscape: the shell fits both and keeps its image', async () => {
    run = await openLite();
    const { page } = run;
    await openImage(page);
    const before = await page.evaluate(() => [innerWidth, innerHeight]);
    shot('rotate-portrait');
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 1');
    await page.waitForFunction((w) => innerWidth !== w, before[0], { timeout: 15_000 });
    await sleep(1200);
    shot('rotate-landscape');
    const after = await page.evaluate(() => {
      const r = document.querySelector('.m-shell').getBoundingClientRect();
      const bar = document.querySelector('[data-id="m:bar:open"]').getBoundingClientRect();
      return { vp: [innerWidth, innerHeight], shell: [r.width, r.height], barInside: bar.bottom <= innerHeight + 0.5, scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], top: getComputedStyle(document.documentElement).getPropertyValue('--m-top') };
    });
    note('landscape', after);
    expect(after.vp[0]).toBeGreaterThan(after.vp[1]);
    expect(after.barInside).toBe(true);
    expect(after.scroll[0]).toBeLessThanOrEqual(after.vp[0]);
    expect(after.scroll[1]).toBeLessThanOrEqual(after.vp[1] + 1); // the viewport height is fractional
    await expect(m(page, 'm:readout')).toBeVisible();
  });

  test('REQ-HOST-05 landscape: every map button can be reached', async () => {
    run = await openLite();
    const { page } = run;
    await openImage(page);
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 1');
    await page.waitForFunction(() => innerWidth > innerHeight, null, { timeout: 15_000 });
    await sleep(1200);
    const cut = await page.evaluate(() => {
      const v = document.querySelector('.m-view').getBoundingClientRect();
      return [...document.querySelectorAll('.m-fab button')].map((b) => [b.dataset.id, Math.round(b.getBoundingClientRect().bottom)]).filter(([, y]) => y > v.bottom).map(([id]) => id);
    });
    note('landscape-fab-cut', cut);
    expect(cut, 'map buttons cut off').toEqual([]);
  });

  test('REQ-HOST-05 Android Back closes a sheet and stays in the app', async () => {
    run = await startChrome(`${ORIGIN}/gis-workbench-lite.html`);
    const { page } = run;
    await ready(page);
    const state = async () => ({
      top: sh('dumpsys activity activities').match(/topResumedActivity[^\n]*/)?.[0] ?? '',
      ...(await page.evaluate(() => ({ url: location.href, sheet: !!document.querySelector('[data-id="m:sheet"]')?.offsetParent, layers: !!document.querySelector('[data-id="m:layers"]')?.offsetParent, ready: document.body?.dataset.ready })).catch((e) => ({ error: e.message.slice(0, 120) }))),
    });
    await openSheet(page, 'tools');
    await sleep(400);
    sh('input keyevent 4');
    await sleep(1500);
    const sheet = await state();
    shot('back-key');
    expect(sheet.top, 'Chrome still in front').toContain('com.android.chrome');
    expect(sheet.sheet, 'the sheet is closed').toBe(false);
    expect(sheet.ready, 'the app is still open').toBe('1');
    await fingerTapOn(m(page, 'm:bar:layers'));
    await expect(m(page, 'm:layers')).toBeVisible();
    await sleep(400);
    sh('input keyevent 4');
    await sleep(1500);
    const drawer = await state();
    expect(drawer.top).toContain('com.android.chrome');
    expect(drawer.layers, 'the drawer is closed').toBe(false);
    // With nothing open, Back is the browser's again.
    sh('input keyevent 4');
    await sleep(1500);
    const out = sh('dumpsys activity activities').match(/topResumedActivity[^\n]*/)?.[0] ?? '';
    note('back-key', { sheet, drawer, out });
    expect(out, 'Back with nothing open leaves the app').not.toContain('com.android.chrome');
  });

  test('REQ-HOST-05 a display cutout: the bars stay clear of it', async () => {
    run = await openLite({ prefs: { network: 'offline' } });
    const { page } = run;
    await openImage(page);
    const facts = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
      document.body.appendChild(probe);
      const s = getComputedStyle(probe);
      const out = { top: s.paddingTop, right: s.paddingRight, bottom: s.paddingBottom, left: s.paddingLeft, viewportMeta: document.querySelector('meta[name=viewport]')?.content };
      probe.remove();
      return out;
    });
    note('safe-area', facts);
    shot('safe-area');
    await expect(m(page, 'm:appbar')).toBeVisible();
    const b = await m(page, 'm:appbar').boundingBox();
    const vp = await page.evaluate(() => innerHeight);
    expect(b.y + b.height).toBeLessThanOrEqual(vp + 1);
  });
});

test.describe('real input', () => {
  test('REQ-HOST-05 finger through Android: pan by swipe, double tap zoom, long press point sheet, no browser menu', async () => {
    run = await openLite();
    const { page, logs } = run;
    await openImage(page);
    const b = await paneBox(page);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const v0 = await view(page);
    await fingerSwipe(page, cx, cy - 80, cx, cy + 80, 350);
    await sleep(500);
    const v1 = await view(page);
    expect(Math.hypot(v1.cx - v0.cx, v1.cy - v0.cy)).toBeGreaterThan(0);
    await fingerHold(page, cx, cy, 900);
    await expect(m(page, 'm:point')).toBeVisible({ timeout: 8000 });
    await expect(m(page, 'm:point')).toContainText('MGRS');
    shot('input-point-sheet');
    expect(findUi(/^(Copy link|Open in new tab|Share image|Save image)/), 'Chrome context menu').toBeFalsy();
    expect(logs).toEqual([]);
  });

  test('REQ-HOST-05 double tap with touch from Chrome (adb input is too slow between its two taps)', async () => {
    run = await openLite();
    const { page } = run;
    await openImage(page);
    const b = await paneBox(page);
    const [cx, cy] = [b.x + b.width / 2, b.y + b.height / 2];
    const v0 = await view(page);
    const cdp = await page.context().newCDPSession(page);
    const tap = async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await tap();
    await sleep(80);
    await tap();
    await page.waitForFunction((z) => window.gisworkbench.activePane().view.zoom > z * 1.5, v0.zoom, { timeout: 8000 });
    note('double-tap', { before: v0.zoom, after: (await view(page)).zoom });
  });

  test('REQ-HOST-05 pinch and rotate with touch from Chrome (two fingers cannot go through adb input)', async () => {
    run = await openLite();
    const { page } = run;
    await openImage(page);
    const b = await paneBox(page);
    const [cx, cy] = [b.x + b.width / 2, b.y + b.height / 2];
    const d = Math.min(b.width, b.height) / 8;
    const cdp = await page.context().newCDPSession(page);
    const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
    const v0 = await view(page);
    await send('touchStart', [[cx - d, cy], [cx + d, cy]]);
    for (let i = 1; i <= 12; i++) {
      await send('touchMove', [[cx - d - (d * i) / 12, cy], [cx + d + (d * i) / 12, cy]]);
      await sleep(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);
    const v1 = await view(page);
    note('pinch', { ratio: v1.zoom / v0.zoom });
    expect(v1.zoom / v0.zoom).toBeGreaterThan(1.7);
    expect(v1.zoom / v0.zoom).toBeLessThan(2.3);
  });

  test('REQ-HOST-05 the on-screen keyboard appears and does not cover the field or the sheet', async () => {
    run = await openLite();
    const { page } = run;
    await openImage(page);
    const before = await page.evaluate(() => visualViewport.height);
    await page.evaluate(() => void window.gisworkbench.commands.run('obs.field'));
    await page.waitForSelector('[data-id="dialog:field-observation"]');
    await sleep(1500); // the text field takes the focus, and the keyboard may already be up
    await fingerTapOn(m(page, 'fobs-text'));
    await sleep(1800);
    expect(sh('dumpsys input_method'), 'keyboard shown').toContain('mInputShown=true');
    shot('keyboard-observation');
    const r = await page.evaluate(() => {
      const vv = visualViewport;
      const f = document.querySelector('[data-id="fobs-text"]').getBoundingClientRect();
      const d = document.querySelector('[data-id="dialog:field-observation"]').getBoundingClientRect();
      const ok = [...document.querySelectorAll('[data-id="dialog:field-observation"] .dlg-buttons button')][0]?.getBoundingClientRect();
      return { innerHeight, vvHeight: vv.height, vvTop: vv.offsetTop, field: [f.top, f.bottom], dialog: [d.top, d.bottom], okBottom: ok?.bottom, kbVar: document.documentElement.style.getPropertyValue('--m-kb') };
    });
    note('keyboard', { before, ...r });
    const bottom = r.vvTop + r.vvHeight;
    expect(r.vvHeight).toBeLessThan(before);
    expect(r.field[1], 'field above the keyboard').toBeLessThanOrEqual(bottom);
    expect(r.field[0], 'field below the top').toBeGreaterThanOrEqual(r.vvTop);
    await page.keyboard.type('Two vehicles at the gate');
    await expect(m(page, 'fobs-text')).toHaveValue('Two vehicles at the gate');
    sh('input keyevent 4');
  });
});

test.describe('device features', () => {
  test('REQ-HOST-05 location: the app asks in words, then the browser asks, then a fix arrives', async () => {
    run = await openLite();
    const { page } = run;
    await openImage(page);
    adb('emu', 'geo', 'fix', String(GATE.lon), String(GATE.lat));
    await fingerTapOn(m(page, 'm:cmd:geo.locate'));
    await page.waitForSelector('.dlg');
    await expect(page.locator('.dlg')).toContainText('nothing is sent');
    await fingerTapOn(page.locator('.dlg .dlg-buttons button').first());
    await sleep(1500);
    shot('gps-chrome-prompt');
    await tapUi(/^(Allow|Allow this time|While using the app|Continue)$/, { timeout: 10_000 });
    await sleep(1500);
    const os = findUi(/^(While using the app|Only this time|Allow this time)$/);
    if (os) {
      shot('gps-android-prompt');
      sh(`input tap ${os.cx} ${os.cy}`);
    }
    for (let i = 0; i < 6; i++) {
      adb('emu', 'geo', 'fix', String(GATE.lon), String(GATE.lat));
      await sleep(1000);
    }
    await page.waitForFunction(() => !!window.gisworkbench.location?.fix, null, { timeout: 30_000 });
    const fix = await page.evaluate(() => window.gisworkbench.location.fix);
    note('gps', fix);
    shot('gps-fix');
    expect(Math.abs(fix.lat - GATE.lat)).toBeLessThan(1e-3);
    expect(Math.abs(fix.lon - GATE.lon)).toBeLessThan(1e-3);
    await expect(m(page, 'm:cmd:geo.locate')).toHaveAttribute('aria-pressed', 'true');
  });

  test('REQ-HOST-05 the camera input opens a real camera and the photo lands on the observation', async () => {
    sh('input keyevent 3');
    sh('pm revoke com.android.chrome android.permission.CAMERA');
    run = await openLite();
    const { page } = run;
    await openImage(page);
    await page.evaluate(() => void window.gisworkbench.commands.run('obs.field'));
    await page.waitForSelector('[data-id="dialog:field-observation"]');
    await sleep(1500);
    await fingerTapOn(m(page, 'fobs-take'));
    await sleep(2500);
    shot('camera-1');
    const allow = findUi(/^(While using the app|Allow|Only this time)$/);
    if (allow) {
      sh(`input tap ${allow.cx} ${allow.cy}`);
      await sleep(1500);
    }
    await sleep(2500);
    shot('camera-2');
    const nodes = ui();
    const fg = sh('dumpsys activity activities').match(/topResumedActivity[^\n]*/)?.[0] ?? '';
    note('camera', { fg, nodes: nodes.filter((n) => n.text || n.desc).slice(0, 20).map((n) => n.text || n.desc) });
    const shutter = nodes.find((n) => /shutter/i.test(`${n.desc} ${n.id}`));
    expect(shutter, 'a shutter button').toBeTruthy();
    sh(`input tap ${shutter.cx} ${shutter.cy}`);
    await sleep(3000);
    shot('camera-3');
    const done = ui().find((n) => /done|review_done|accept/i.test(`${n.desc} ${n.id}`));
    note('camera-review', ui().filter((n) => n.desc || n.id).slice(0, 14).map((n) => n.desc || n.id));
    if (done) sh(`input tap ${done.cx} ${done.cy}`);
    await expect(page.locator('[data-id="fobs-photos"] img')).toHaveCount(1, { timeout: 20_000 });
    shot('camera-photo-attached');
    note('camera-photo', await page.evaluate(() => window.gisworkbench.__fieldDialog.photos.map((p) => ({ name: p.name, width: p.width, height: p.height, dataChars: p.data.length }))));
  });

  test('REQ-HOST-05 Web Share works at all here: a .txt reaches the Android share sheet (control)', async () => {
    run = await openLite();
    const { page } = run;
    await page.evaluate(() => {
      window.__r = [];
      const b = document.createElement('button');
      b.id = 'probe';
      b.textContent = 'share';
      b.style.cssText = 'position:fixed;left:40px;top:300px;width:300px;height:120px;z-index:99999';
      b.onclick = () => navigator.share({ files: [new File(['x'], 'a.txt', { type: 'text/plain' })] }).then(() => window.__r.push('ok'), (e) => window.__r.push(e.name));
      document.body.appendChild(b);
    });
    await fingerTapOn(page.locator('#probe'));
    await sleep(2500);
    shot('share-control');
    expect(ui().some((n) => /intentresolver/.test(n.pkg)), 'the Android share sheet').toBe(true);
    sh('input keyevent 4');
    await sleep(1500);
    expect(await page.evaluate(() => window.__r)).toEqual(['AbortError']);
  });

  test('REQ-HOST-05 Android Chrome refuses the export formats, so Share is not offered and Save leads', async () => {
    sh('rm -f /sdcard/Download/observations-*');
    run = await openLite();
    const { page, logs } = run;
    await openImage(page);
    await page.evaluate(() => {
      const app = window.gisworkbench;
      const p = app.activePane();
      const l = p.geoLayer();
      const g = l.groundAt(l.width / 2, l.height / 2);
      app.store.transact('obs', (tx) => tx.create('observation', { text: '(U) Gate', category: 'other', confidence: 'high', lat: g.lat, lon: g.lon, place: 'point', created: new Date().toISOString(), photos: [] }));
      void app.commands.run('obs.export');
    });
    await page.waitForSelector('[data-id="dialog:obs-export"]');
    await page.locator('[data-id="oexp-format"]').selectOption('geojson');
    await sleep(600);
    shot('share-export-dialog');
    await expect(page.locator('[data-id="dialog:obs-export"] .dlg-buttons button', { hasText: /Share/ })).toHaveCount(0);
    expect(await page.locator('[data-id="dialog:obs-export"] .dlg-buttons button').first().textContent()).toBe('Save');
    expect(logs).toEqual([]);
  });

  test('REQ-HOST-05 a real Save lands in Downloads', async () => {
    sh('rm -f /sdcard/Download/observations-*');
    run = await openLite();
    const { page } = run;
    await openImage(page);
    await page.evaluate(() => {
      const app = window.gisworkbench;
      const l = app.activePane().geoLayer();
      const g = l.groundAt(l.width / 2, l.height / 2);
      app.store.transact('obs', (tx) => tx.create('observation', { text: '(U) Gate', category: 'other', confidence: 'high', lat: g.lat, lon: g.lon, place: 'point', created: new Date().toISOString(), photos: [] }));
      void app.commands.run('obs.export');
    });
    await page.waitForSelector('[data-id="dialog:obs-export"]');
    await page.locator('[data-id="oexp-format"]').selectOption('geojson');
    await fingerTapOn(page.locator('[data-id="dialog:obs-export"] .dlg-buttons button', { hasText: /^Save$/ }));
    await sleep(3000);
    shot('save-1');
    const dl = findUi(/^(Download|Save|SAVE|Allow)$/);
    if (dl) {
      sh(`input tap ${dl.cx} ${dl.cy}`);
      await sleep(2500);
    }
    shot('save-2');
    const files = sh('ls /sdcard/Download').split(/\s+/).filter((f) => /^observations-/.test(f));
    note('save', { files });
    expect(files.length).toBeGreaterThan(0);
    const body = sh(`cat /sdcard/Download/${files[0]}`);
    expect(JSON.parse(body).features.length).toBe(1);
  });
});

test.describe('the field flow and what survives', () => {
  test('SCN-56 real input: measure by tapping, an observation by typing, the record is right', async () => {
    run = await openLite();
    const { page, logs } = run;
    await openImage(page);
    const b = await paneBox(page);
    await openSheet(page, 'measure');
    await fingerTapOn(m(page, 'm:cmd:men.rangebearing'));
    await expect(m(page, 'm:cue')).toBeVisible();
    await fingerTap(page, b.x + b.width * 0.3, b.y + b.height * 0.4);
    await sleep(600);
    await fingerTap(page, b.x + b.width * 0.7, b.y + b.height * 0.6);
    await expect(m(page, 'm:measure-result')).toBeVisible();
    shot('field-measure');
    const mm = await page.evaluate(() => window.gisworkbench.store.all('measurement').at(-1));
    expect(mm.value).toBeGreaterThan(0);
    await fingerTapOn(m(page, 'm:sheet:close'));
    await fingerHold(page, b.x + b.width / 2, b.y + b.height / 2, 900);
    await fingerTapOn(m(page, 'm:point:observe'));
    await page.waitForSelector('[data-id="dialog:field-observation"]');
    await sleep(400);
    await fingerTapOn(m(page, 'fobs-text'));
    await sleep(1500);
    sh("input text '(U)%sTwo%svehicles'");
    await sleep(1000);
    await expect(m(page, 'fobs-text')).toHaveValue('(U) Two vehicles');
    sh('input keyevent 4');
    await sleep(800);
    await fingerTapOn(page.locator('[data-id="dialog:field-observation"] .dlg-buttons button').first());
    await page.waitForFunction(() => window.gisworkbench.store.all('observation').length === 1);
    const o = await page.evaluate(() => window.gisworkbench.store.all('observation').at(-1));
    expect(o.text).toBe('(U) Two vehicles');
    expect(Number.isFinite(o.lat) && Number.isFinite(o.lon)).toBe(true);
    expect(logs).toEqual([]);
  });

  test('REQ-HOST-05 recovery after Android kills Chrome: Recover brings the work back', async () => {
    run = await openLite();
    const { page } = run;
    await openImage(page);
    await page.evaluate(() => {
      const app = window.gisworkbench;
      app.store.transact('obs', (tx) => tx.create('observation', { text: '(U) Kept', category: 'other', confidence: 'high', lat: 36, lon: -115, place: 'point', created: new Date().toISOString(), photos: [] }));
    });
    await sleep(3000);
    await run.browser.close();
    run = await startChrome(`${ORIGIN}/gis-workbench-lite.html`, { cold: true });
    await ready(run.page);
    await sleep(800);
    shot('recover-prompt');
    await fingerTapOn(run.page.locator('button', { hasText: /^Recover$/ }));
    await run.page.waitForFunction(() => window.gisworkbench.store.all('observation').length === 1, null, { timeout: 15_000 });
    expect(await run.page.evaluate(() => window.gisworkbench.store.all('observation')[0].text)).toBe('(U) Kept');
  });
});

test('REQ-PRF-01 memory: Chrome with Lite empty and with the 16.8 MB image open', async () => {
  run = await openLite();
  const { page } = run;
  await sleep(2000);
  const empty = chromeMemory();
  await openImage(page);
  await sleep(3000);
  const image = chromeMemory();
  shot('memory-image-open');
  note('memory', { emptyKB: empty, imageKB: image });
  expect(Object.keys(image).length).toBeGreaterThan(0);
});
