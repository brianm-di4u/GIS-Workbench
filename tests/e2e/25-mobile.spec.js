// OD-2.23 (REQ-HOST-05 amended, SCN-56): GIS Workbench Lite, the mobile build, on emulated phones
// and a tablet (Chrome and Edge mobile emulation: viewport, device pixel ratio, touch, mobile user
// agent): the mobile GUI and no desktop shell; touch targets; axe on every Lite screen; gestures
// through CDP touch events (pinch, two-finger rotate, double tap, long press); the field set end to
// end (open, measure, observation with a photo, export as GeoJSON and KML/KMZ, Web Share);
// the AOI, GRG and annotations in the export; recovery after a reload; a snapshot that reopens;
// the device location; the Lite command list at run time; no sidecar in Lite (PT-14 amended);
// a pseudo-locale sweep; the Full file's notice on a phone; the Lite size gate.
//
// Not covered here (owner item): real iOS Safari and Android Chrome on real phones.

import { test, expect, devices } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { unzipSync, strFromU8 } from 'fflate';
import { openApp, openFiles, servers, DIST, DIST_DIR, ROOT, restart } from './helpers.js';

const LITE = join(DIST_DIR, 'gis-workbench-lite.html');
const FX = (...p) => join(ROOT, 'fixtures', ...p);
const IMAGE = FX('fx01', 'fx01.ntf');
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const LITE_LIST = JSON.parse(readFileSync(join(ROOT, 'app', 'src', 'data', 'lite-commands.json'), 'utf8'));
const LITE_IDS = LITE_LIST.groups.flatMap((g) => g.commands);
const DNT = JSON.parse(readFileSync(join(ROOT, 'app', 'src', 'i18n', 'glossary', 'dnt.json'), 'utf8')).tokens;

/** A Playwright device as Chromium can emulate it (the descriptors name WebKit for iPhones and iPads). */
const as = (name, over = {}) => {
  const d = devices[name];
  return { viewport: d.viewport, screen: d.screen, deviceScaleFactor: d.deviceScaleFactor, isMobile: d.isMobile, hasTouch: d.hasTouch, userAgent: d.userAgent, reducedMotion: 'reduce', ...over }; // no sheet animation under the measurements
};
const PHONES = [
  ['iPhone 15', as('iPhone 15')],
  ['Pixel 7', as('Pixel 7')],
  ['iPhone 15 landscape', as('iPhone 15 landscape')],
];
const TABLET = ['iPad (gen 7) landscape', as('iPad (gen 7) landscape')];

async function axe(frame, sel = 'body') {
  if (!(await frame.evaluate(() => !!window.axe))) await frame.evaluate(AXE);
  return frame.evaluate(async ([s, tags]) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: tags } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 4).join(', ')}`), [sel, AXE_TAGS]);
}

let liteServer;
async function lite(page, prefs = { network: 'offline' }) {
  // npm run test:webkit: WebKit cannot read a chosen file from a file:// page (blob:null), and an
  // iPhone has no file:// route to the app anyway. See docs/validation/2.5/ios-simulator.md.
  const webkit = page.context().browser().browserType().name() === 'webkit';
  if (webkit) liteServer ??= await servers(LITE);
  const r = await openApp(page, webkit ? 'http' : 'file', { srv: liteServer, htmlPath: LITE, prefs });
  // Saves come back to the test (storage/files.js saveBlob), and Web Share is recorded.
  await r.frame.evaluate(() => {
    window.__saved = [];
    window.gisworkbench.saveCapture = (blob, name) => window.__saved.push({ blob, name });
    // The last touch events, for the message when a long press opens nothing (#17).
    window.__touches = [];
    const t0 = performance.now();
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'contextmenu'])
      window.addEventListener(type, (e) => window.__touches.push(`${Math.round(performance.now() - t0)} ${type} ${e.pointerId ?? ''} ${e.target?.dataset?.id ?? e.target?.getAttribute?.('class') ?? e.target?.nodeName}`.slice(0, 120)) > 60 && window.__touches.shift(), { capture: true });
  });
  return r;
}

/** The visible image panel's box in page coordinates. */
const paneBox = (page) => page.locator('.m-view .pane').boundingBox();

/** WebKit has no CDP, so there the app gets touch pointer events; real touch is on the simulator. */
const isWebKit = (page) => page.context().browser().browserType().name() === 'webkit';
function pointerFrames(page, frames, stepMs, holdMs = 0) {
  return page.evaluate(
    async ([frames, stepMs, holdMs]) => {
      const el = document.querySelector('.m-view .pane');
      const fire = (type, f) => f.forEach(([clientX, clientY], i) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', pointerId: i + 1, isPrimary: i === 0, clientX, clientY, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1 })));
      fire('pointerdown', frames[0]);
      for (const f of frames.slice(1)) {
        await new Promise((r) => setTimeout(r, stepMs));
        fire('pointermove', f);
      }
      await new Promise((r) => setTimeout(r, holdMs));
      fire('pointerup', frames.at(-1));
    },
    [frames, stepMs, holdMs],
  );
}

/**
 * Wait until the image shows at every point, as a user would before touching it. A toast's button
 * can cover the image for its 8 seconds: while the activity bar shows, the toasts sit lower, and on a
 * phone in landscape that is over the centre (#17).
 */
const onMap = (page, pts) => page.waitForFunction((pts) => pts.every(([x, y]) => document.elementFromPoint(x, y)?.closest('.m-view .pane')), pts, { timeout: 15_000 });

/** Touch with CDP: a sequence of frames, each a list of [x, y] points (ids by position). */
async function touch(page, frames, { stepMs = 16 } = {}) {
  if (isWebKit(page)) return pointerFrames(page, frames, stepMs);
  await onMap(page, frames[0]);
  const cdp = await page.context().newCDPSession(page);
  const pts = (f) => f.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(frames[0]) });
  for (const f of frames.slice(1)) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(f) });
    await page.waitForTimeout(stepMs);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const lerp = (a, b, k) => a + (b - a) * k;
/** Two fingers from (a0, b0) to (a1, b1) in n steps. */
const twoFinger = (a0, b0, a1, b1, n = 12) => Array.from({ length: n + 1 }, (_, i) => [[lerp(a0[0], a1[0], i / n), lerp(a0[1], a1[1], i / n)], [lerp(b0[0], b1[0], i / n), lerp(b0[1], b1[1], i / n)]]);

async function longPress(page, x, y, ms = 800) {
  if (isWebKit(page)) return pointerFrames(page, [[[x, y]]], 16, ms);
  await onMap(page, [[x, y]]);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  // Every caller expects the point sheet. When it doesn't come, say what the page saw.
  try {
    await expect(page.locator('[data-id="m:point"]')).toBeVisible({ timeout: 10_000 });
  } catch {
    const seen = await page.evaluate(([x, y]) => ({ at: document.elementFromPoint(x, y)?.getAttribute('class'),toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent), sheet: document.querySelector('[data-id="m:sheet"]')?.textContent?.slice(0, 80) ?? null, touches: window.__touches }), [x, y]);
    throw new Error(`No point sheet after a long press at ${x},${y}: ${JSON.stringify(seen, null, 1)}`);
  }
}

const view = (frame) => frame.evaluate(() => ({ ...window.gisworkbench.activePane().view }));
const openSheet = async (page, which) => {
  await page.locator(`[data-id="m:bar:${which}"]`).tap();
  await expect(page.locator('[data-id="m:sheet"]')).toBeVisible();
};
const closeSheet = (page) => page.locator('[data-id="m:sheet:close"]').tap();
/** A small JPEG made by the page itself (a camera photo stand-in). */
const jpeg = (frame) =>
  frame.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 480;
    const g = c.getContext('2d');
    g.fillStyle = '#3a7';
    g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#fff';
    g.fillRect(100, 100, 200, 120);
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    return [...new Uint8Array(await b.arrayBuffer())];
  });

for (const [name, dev] of PHONES) {
  test.describe(`Lite on ${name}`, () => {
    test.use(dev);

    test(`REQ-HOST-05 SCN-56 mobile GUI only, touch targets, axe on every screen (${name})`, async ({ page }) => {
      test.setTimeout(240_000);
      const { frame, logs } = await lite(page);
      expect(await frame.evaluate(() => window.__gw.manifest.build.profile)).toBe('lite');
      // The mobile shell, and no desktop shell, Ribbon, docks or Workspace.
      const dom = await frame.evaluate(() => ({ shell: !!document.querySelector('.m-shell'), ribbon: !!document.querySelector('.ribbon, .ribbon-tabs'), mp: !!document.querySelector('section.multiport, .desktop, .nav-rail, .app-bar, .gwin'), touch: matchMedia('(pointer: coarse)').matches, edition: document.documentElement.dataset.edition }));
      expect(dom).toEqual({ shell: true, ribbon: false, mp: false, touch: true, edition: 'lite' });
      expect(await page.title()).toBe('GIS Workbench Lite');
      // Every control of the shell is at least 44 × 44 CSS px (WCAG 2.2 target size; AAA level).
      const small = async () => frame.evaluate(() => [...document.querySelectorAll('.m-shell button, .m-shell select, .m-shell input:not(.sr-only), .dlg button, .dlg select, .dlg input:not(.sr-only):not([type="checkbox"]):not([type="radio"])')].filter((b) => b.offsetParent !== null).map((b) => [b.dataset.id ?? b.className, Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]).filter(([, w, h]) => w < 44 || h < 44));
      expect(await small()).toEqual([]);
      expect(await axe(frame), 'empty screen').toEqual([]);
      // The first-run card and the map buttons do not cover each other.
      expect(await frame.evaluate(() => {
        const c = document.querySelector('[data-id="m:empty"]').getBoundingClientRect();
        return [...document.querySelectorAll('.m-fab button')].filter((b) => getComputedStyle(b).visibility === 'visible').map((b) => b.getBoundingClientRect()).filter((r) => r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top).length;
      })).toBe(0);
      for (const s of ['open', 'measure', 'observe', 'tools']) {
        await openSheet(page, s);
        expect(await small(), s).toEqual([]);
        expect(await axe(frame), `${s} sheet`).toEqual([]);
        // The sheet stays inside the screen.
        const b = await page.locator('[data-id="m:sheet"]').boundingBox();
        const vp = page.viewportSize();
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 0.5);
        expect(b.y).toBeGreaterThanOrEqual(0);
        await closeSheet(page);
        await expect(page.locator('[data-id="m:sheet"]')).toBeHidden();
      }
      await page.locator('[data-id="m:bar:layers"]').tap();
      await expect(page.locator('[data-id="m:layers"]')).toBeVisible();
      expect(await axe(frame), 'layers drawer').toEqual([]);
      await page.locator('[data-id="m:layers:close"]').tap();
      // With an image: the readout chip, the point sheet, and the dialogs of the shared features.
      await openFiles(frame, [IMAGE]);
      await expect(page.locator('[data-id="m:readout"]')).toBeVisible();
      await expect(page.locator('[data-id="m:empty"]')).toBeHidden();
      expect(await small()).toEqual([]);
      expect(await axe(frame), 'image').toEqual([]);
      const pb = await paneBox(page);
      await longPress(page, pb.x + pb.width / 2, pb.y + pb.height / 2);
      await expect(page.locator('[data-id="m:point"]')).toBeVisible();
      expect(await axe(frame), 'point sheet').toEqual([]);
      await closeSheet(page);
      for (const [cmd, dlg] of [['obs.field', 'field-observation'], ['nav.jump', 'jump'], ['geo.convert', null], ['file.prefs', null], ['help.about', 'about'], ['grid.grg', 'grid-grg']]) {
        await frame.evaluate((c) => {
          window.gisworkbench.commands.run(c);
        }, cmd);
        const sel = dlg ? `[data-id="dialog:${dlg}"]` : '.dlg';
        await frame.waitForSelector(sel, { timeout: 15_000 });
        const box = await page.locator(sel).first().boundingBox();
        expect(box.width, cmd).toBeLessThanOrEqual(page.viewportSize().width + 0.5);
        expect(await small(), cmd).toEqual([]);
        expect(await axe(frame, sel), cmd).toEqual([]);
        await page.keyboard.press('Escape');
        await frame.waitForFunction(() => !document.querySelector('.dlg'));
      }
      expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
    });

    test(`REQ-HOST-05 gestures: pinch, two-finger rotate, double tap, long press (${name})`, async ({ page }) => {
      test.setTimeout(180_000);
      const { frame } = await lite(page);
      // The first-run card goes in the same step as the image arrives: it covers the image, so a
      // gesture that starts while it shows is lost. No wait here: the pinch follows the open at once.
      await frame.evaluate(() => {
        const app = window.gisworkbench;
        const card = document.querySelector('[data-id="m:empty"]');
        window.__cardAtOpen = [];
        app.on('state', () => {
          if (app.activePane()?.layers().length) window.__cardAtOpen.push(card.hidden);
        });
      });
      await openFiles(frame, [IMAGE]);
      const cardAtOpen = await frame.evaluate(() => window.__cardAtOpen);
      expect(cardAtOpen.length).toBeGreaterThan(0);
      expect(cardAtOpen).not.toContain(false);
      await frame.waitForFunction(() => window.gisworkbench.activePane().view.zoom > 0);
      const b = await paneBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const d = Math.min(b.width, b.height) / 8;
      // Pinch out ×2 about the centre: the zoom doubles and no rotation starts.
      const v0 = await view(frame);
      await touch(page, twoFinger([cx - d, cy], [cx + d, cy], [cx - 2 * d, cy], [cx + 2 * d, cy]));
      const v1 = await view(frame);
      expect(v1.zoom / v0.zoom).toBeGreaterThan(1.85);
      expect(v1.zoom / v0.zoom).toBeLessThan(2.15);
      expect(Math.abs(v1.rot - v0.rot)).toBeLessThan(1e-9);
      // The image point under the fingers stays under them.
      expect(Math.hypot(v1.cx - v0.cx, v1.cy - v0.cy) * v1.zoom).toBeLessThan(6);
      // Two fingers turned by 60°: the view rotates by 60° less the 12° threshold.
      const ang = (60 * Math.PI) / 180;
      const frames = Array.from({ length: 21 }, (_, i) => {
        const a = (ang * i) / 20;
        return [[cx - d * Math.cos(a), cy - d * Math.sin(a)], [cx + d * Math.cos(a), cy + d * Math.sin(a)]];
      });
      await touch(page, frames);
      const v2 = await view(frame);
      expect(((v2.rot - v1.rot) * 180) / Math.PI).toBeGreaterThan(44);
      expect(((v2.rot - v1.rot) * 180) / Math.PI).toBeLessThan(52);
      expect(v2.zoom / v1.zoom).toBeGreaterThan(0.95);
      expect(v2.mode).toBe('free');
      // North up again from the map button.
      await page.locator('[data-id="m:cmd:rot.north"]').tap();
      await frame.waitForFunction((r) => Math.abs(window.gisworkbench.activePane().view.rot - r) > 0.1, v2.rot);
      // One finger pans.
      const v3 = await view(frame);
      await touch(page, Array.from({ length: 11 }, (_, i) => [[cx, cy + i * 8]]));
      const v4 = await view(frame);
      expect(Math.hypot(v4.cx - v3.cx, v4.cy - v3.cy) * v4.zoom).toBeGreaterThan(60);
      // Double tap: ×2.
      await page.touchscreen.tap(cx, cy);
      await page.waitForTimeout(80);
      await page.touchscreen.tap(cx, cy);
      await frame.waitForFunction((z) => window.gisworkbench.activePane().view.zoom > z * 1.8, v4.zoom);
      // Long press: the point readout with MGRS and lat/lon, and no browser context menu.
      await longPress(page, cx, cy);
      await expect(page.locator('[data-id="m:point"]')).toContainText('MGRS');
      const ll = await page.locator('[data-id="m:point"] dd').nth(1).textContent();
      expect(ll).toMatch(/\d+\.\d{6}/);
    });

    test(`SCN-56 field set end to end: open, measure, observation with a photo, export and share (${name})`, async ({ page }) => {
      test.setTimeout(240_000);
      const { frame, logs } = await lite(page);
      await openFiles(frame, [IMAGE]);
      const b = await paneBox(page);
      // Measure distance and bearing by tapping two points.
      await openSheet(page, 'measure');
      await page.locator('[data-id="m:cmd:men.rangebearing"]').tap();
      await expect(page.locator('[data-id="m:cue"]')).toBeVisible();
      await page.touchscreen.tap(b.x + b.width * 0.3, b.y + b.height * 0.4);
      await page.waitForTimeout(400);
      await page.touchscreen.tap(b.x + b.width * 0.7, b.y + b.height * 0.6);
      await expect(page.locator('[data-id="m:measure-result"]')).toBeVisible();
      const m = await frame.evaluate(() => window.gisworkbench.store.all('measurement').at(-1));
      expect(m.mtype).toBe('Range & Bearing');
      expect(m.value).toBeGreaterThan(0);
      await expect(page.locator('[data-id="m:measure-result"]')).toContainText('°');
      // The result equals the core's geodesic between the two ground points (the same maths as Full).
      const check = await frame.evaluate((r) => {
        const app = window.gisworkbench;
        const [a, b2] = r.geom;
        return app.core.inverse(a[1], a[0], b2[1], b2[0]).distance;
      }, m);
      expect(Math.abs(check - m.value)).toBeLessThan(0.01);
      await closeSheet(page);
      // Polygon area: three taps and Finish.
      await openSheet(page, 'measure');
      await page.locator('[data-id="m:cmd:men.area"]').tap();
      for (const [kx, ky] of [[0.3, 0.3], [0.7, 0.3], [0.5, 0.7]]) {
        await page.touchscreen.tap(b.x + b.width * kx, b.y + b.height * ky);
        await page.waitForTimeout(400);
      }
      await page.locator('[data-id="m:cue:finish"]').tap();
      await frame.waitForFunction(() => window.gisworkbench.store.all('measurement').at(-1)?.mtype === 'Area');
      // A pinch while a tool is active does not add a point.
      await openSheet(page, 'measure');
      await page.locator('[data-id="m:cmd:men.length"]').tap();
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      await touch(page, twoFinger([cx - 40, cy], [cx + 40, cy], [cx - 80, cy], [cx + 80, cy]));
      expect(await frame.evaluate(() => window.gisworkbench.tools.current?.state?.pts?.length ?? 0)).toBe(0);
      await page.locator('[data-id="m:cue:cancel"]').tap();
      // A field observation at a pressed point, with a photo from the device.
      await longPress(page, cx, cy);
      await page.locator('[data-id="m:point:observe"]').tap();
      await frame.waitForSelector('[data-id="dialog:field-observation"]');
      await page.locator('[data-id="fobs-text"]').fill('(U) Two vehicles at the gate');
      await page.locator('[data-id="fobs-category"]').selectOption('vehicle activity');
      expect(await page.locator('[data-id="fobs-place"]').inputValue()).toBe('point');
      const photo = await jpeg(frame);
      await page.locator('[data-id="fobs-gallery"]').setInputFiles({ name: 'gate.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(photo) });
      await expect(page.locator('[data-id="fobs-photos"] img')).toHaveCount(1);
      expect(await axe(frame, '[data-id="dialog:field-observation"]')).toEqual([]);
      // The camera input asks for the rear camera on a phone.
      expect(await page.locator('[data-id="fobs-camera"]').getAttribute('capture')).toBe('environment');
      await page.locator('[data-id="dialog:field-observation"] .dlg-buttons button').first().tap();
      const obs = await frame.evaluate(() => window.gisworkbench.store.all('observation').at(-1));
      expect(obs.text).toBe('(U) Two vehicles at the gate');
      expect(obs.place).toBe('point');
      expect(obs.photos.length).toBe(1);
      expect(obs.photos[0].data).toMatch(/^data:image\/jpeg;base64,/);
      expect(obs.photos[0].width).toBe(640);
      expect(Number.isFinite(obs.lat) && Number.isFinite(obs.lon)).toBe(true);
      // Export: GeoJSON and KMZ (photos inside), saved; then shared through the Web Share API.
      const exportAs = async (fmt, button = 'save') => {
        await frame.evaluate(() => {
          window.gisworkbench.commands.run('obs.export');
        });
        await frame.waitForSelector('[data-id="dialog:obs-export"]');
        expect(await axe(frame, '[data-id="dialog:obs-export"]')).toEqual([]);
        await page.locator('[data-id="oexp-format"]').selectOption(fmt);
        const label = button === 'share' ? /Share/ : /^Save$/;
        await page.locator('[data-id="dialog:obs-export"] .dlg-buttons button', { hasText: label }).tap();
      };
      await exportAs('geojson');
      await frame.waitForFunction(() => window.__saved.length === 1);
      const gj = JSON.parse(await frame.evaluate(() => window.__saved[0].blob.text()));
      expect(gj.features.length).toBe(1);
      expect(gj.features[0].properties.text).toBe('(U) Two vehicles at the gate');
      expect(gj.features[0].geometry.coordinates[1]).toBeCloseTo(obs.lat, 9);
      expect(gj.features[0].properties.photos[0].href).toMatch(/^data:image\/jpeg/);
      await exportAs('kml');
      await frame.waitForFunction(() => window.__saved.length === 2);
      const kmz = await frame.evaluate(async () => ({ name: window.__saved[1].name, bytes: [...new Uint8Array(await window.__saved[1].blob.arrayBuffer())] }));
      expect(kmz.name).toMatch(/\.kmz$/);
      const z = unzipSync(new Uint8Array(kmz.bytes));
      expect(strFromU8(z['doc.kml'])).toContain('Two vehicles at the gate');
      expect(Object.keys(z).filter((k) => k.startsWith('files/')).length).toBe(1);
      // Web Share where the browser has it (stubbed: the emulated browser decides nothing here).
      await frame.evaluate(() => {
        window.__shared = [];
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => !!d?.files?.length });
        Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => void window.__shared.push(d.files.map((f) => [f.name, f.type, f.size])) });
      });
      if (/Android/.test(dev.userAgent)) {
        // Android Chrome answers yes through canShare and refuses these formats: Save stands alone.
        await frame.evaluate(() => void window.gisworkbench.commands.run('obs.export'));
        await frame.waitForSelector('[data-id="dialog:obs-export"]');
        await expect(page.locator('[data-id="dialog:obs-export"] .dlg-buttons button', { hasText: /Share/ })).toHaveCount(0);
        await page.keyboard.press('Escape');
      } else {
        await exportAs('geojson', 'share');
        await frame.waitForFunction(() => window.__shared.length === 1);
        const shared = await frame.evaluate(() => window.__shared[0][0]);
        expect(shared[0]).toMatch(/^observations-\d{14}\.geojson$/);
        expect(shared[1]).toBe('application/geo+json');
        expect(await frame.evaluate(() => window.__saved.length)).toBe(2); // shared, not saved
      }
      // Observation table as a sheet.
      await openSheet(page, 'observe');
      await page.locator('[data-id="m:cmd:obs.table"]').tap();
      await expect(page.locator('[data-id="obs-table"]')).toContainText('Two vehicles at the gate');
      expect(await axe(frame)).toEqual([]);
      expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
    });
  });
}

test.describe('Lite: a double tap as Safari on iOS reports it', () => {
  test.use(as('iPhone 15'));
  test('REQ-HOST-05 one pointer tap, then only dblclick, zooms in', async ({ page }) => {
    const { frame } = await lite(page);
    await openFiles(frame, [IMAGE]);
    await frame.waitForFunction(() => window.gisworkbench.activePane().view.zoom > 0);
    const b = await paneBox(page);
    const before = (await view(frame)).zoom;
    await page.evaluate(([clientX, clientY]) => {
      const el = document.querySelector('.m-view .pane');
      const opts = { bubbles: true, cancelable: true, composed: true, clientX, clientY };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0 }));
      el.dispatchEvent(new MouseEvent('dblclick', opts));
    }, [b.x + b.width / 2, b.y + b.height / 2]);
    await frame.waitForFunction((z) => window.gisworkbench.activePane().view.zoom > z * 1.5, before);
  });
});

test.describe(`Lite on ${TABLET[0]}`, () => {
  test.use(TABLET[1]);
  test('REQ-HOST-05 tablet: the same mobile GUI, sheets at a readable width, the image fills the screen', async ({ page }) => {
    const { frame } = await lite(page);
    await openFiles(frame, [IMAGE]);
    const vp = page.viewportSize();
    const pb = await paneBox(page);
    expect(pb.width).toBeGreaterThan(vp.width - 2);
    await openSheet(page, 'tools');
    const sb = await page.locator('[data-id="m:sheet"]').boundingBox();
    expect(sb.width).toBeLessThanOrEqual(34 * 16 + 1);
    expect(Math.abs(sb.x + sb.width / 2 - vp.width / 2)).toBeLessThan(2);
    expect(await axe(frame)).toEqual([]);
    // A hardware keyboard: Escape closes the sheet.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-id="m:sheet"]')).toBeHidden();
  });
});

test.describe('Lite: location, command list, sidecar, languages, size', () => {
  test.use(as('Pixel 7'));

  test('REQ-HOST-05 a long press opens the point sheet when the page is too busy to run its timer', async ({ page }) => {
    const { frame } = await lite(page);
    await openFiles(frame, [IMAGE]);
    // A busy page runs the release before the long-press timer (#17): hold the timer back for 2 s.
    await page.evaluate(() => {
      const later = window.setTimeout;
      window.setTimeout = (fn, ms, ...a) => later(fn, ms === 550 ? ms + 2000 : ms, ...a);
    });
    const b = await paneBox(page);
    await longPress(page, b.x + b.width / 2, b.y + b.height / 2);
  });

  test('REQ-HOST-05 Back closes a sheet, the drawer and a dialog in turn, and stays in the app', async ({ page }) => {
    const { frame } = await lite(page);
    await openFiles(frame, [IMAGE]);
    const back = async () => {
      await page.waitForTimeout(150); // the entry in front of the app goes in just after the sheet opens
      await page.evaluate(() => history.back());
    };
    await openSheet(page, 'tools');
    await back();
    await expect(page.locator('[data-id="m:sheet"]')).toBeHidden();
    await page.waitForTimeout(150);
    await page.locator('[data-id="m:bar:layers"]').tap();
    await expect(page.locator('[data-id="m:layers"]')).toBeVisible();
    await back();
    await expect(page.locator('[data-id="m:layers"]')).toBeHidden();
    await page.waitForTimeout(150);
    await frame.evaluate(() => void window.gisworkbench.commands.run('obs.field'));
    await frame.waitForSelector('[data-id="dialog:field-observation"]');
    await back();
    await expect(page.locator('[data-id="dialog:field-observation"]')).toHaveCount(0);
    await page.waitForTimeout(150);
    // A sheet closed by its own button takes its entry with it, so Back does not stop twice.
    await openSheet(page, 'tools');
    await page.waitForTimeout(150);
    await closeSheet(page);
    await page.waitForTimeout(250);
    expect(await frame.evaluate(() => history.state)).toBeNull();
    expect(await frame.evaluate(() => window.gisworkbench.store.all('layer').length)).toBe(1); // still the same app
  });

  test('REQ-HOST-05 a phone in landscape reaches every map button', async ({ page }) => {
    await page.setViewportSize({ width: 862, height: 327 });
    const { frame } = await lite(page);
    await openFiles(frame, [IMAGE]);
    const r = await frame.evaluate(() => {
      const v = document.querySelector('.m-view').getBoundingClientRect();
      return [...document.querySelectorAll('.m-fab button')].map((b) => b.getBoundingClientRect()).map((b) => ({ inside: b.bottom <= v.bottom && b.top >= v.top && b.left >= v.left && b.right <= v.right, w: b.width }));
    });
    expect(r.length).toBe(5);
    expect(r.filter((b) => !b.inside)).toEqual([]);
  });

  test('REQ-HOST-05 My Location: asked in words first, then the browser; the view centres on the fix', async ({ page, context }) => {
    const { frame } = await lite(page);
    await openFiles(frame, [IMAGE]);
    // A place on the image: the ground under a point off the centre.
    const g = await frame.evaluate(() => {
      const p = window.gisworkbench.activePane();
      const l = p.geoLayer();
      return l.groundAt(l.width * 0.25, l.height * 0.75);
    });
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: g.lat, longitude: g.lon, accuracy: 15 });
    await page.locator('[data-id="m:cmd:geo.locate"]').tap();
    await frame.waitForSelector('.dlg');
    await expect(page.locator('.dlg')).toContainText('nothing is sent');
    await page.locator('.dlg .dlg-buttons button').first().tap();
    await frame.waitForFunction(() => !!window.gisworkbench.location?.fix, null, { timeout: 15_000 });
    const c = await frame.evaluate(() => {
      const p = window.gisworkbench.activePane();
      return p.geoLayer().groundAt(p.view.cx, p.view.cy);
    });
    expect(Math.abs(c.lat - g.lat)).toBeLessThan(1e-4);
    expect(Math.abs(c.lon - g.lon)).toBeLessThan(1e-4);
    await expect(page.locator('[data-id="m:cmd:geo.locate"]')).toHaveAttribute('aria-pressed', 'true');
    // The place offers "My location" for a new observation.
    await frame.evaluate(() => {
      window.gisworkbench.commands.run('obs.field');
    });
    await frame.waitForSelector('[data-id="dialog:field-observation"]');
    expect(await page.locator('[data-id="fobs-place"] option').allTextContents()).toEqual(expect.arrayContaining([expect.stringMatching(/My location/)]));
    await page.keyboard.press('Escape');
    // Off again.
    await page.locator('[data-id="m:cmd:geo.locate"]').tap();
    await expect(page.locator('[data-id="m:cmd:geo.locate"]')).toHaveAttribute('aria-pressed', 'false');
  });

  test('REQ-HOST-05 the Lite command list at run time: every Lite command implemented, every other one refused by name', async ({ page }) => {
    const { frame } = await lite(page);
    const r = await frame.evaluate((ids) => {
      const C = window.gisworkbench.commands;
      const all = C.list();
      return {
        profile: C.profile,
        notImplemented: ids.filter((id) => !C.get(id)?.implemented),
        tagged: ids.filter((id) => C.get(id)?.profiles?.join() !== 'full,lite'),
        offered: [...document.querySelectorAll('[data-cmd]')].map((b) => b.dataset.cmd).filter((id) => !ids.includes(id)),
        fullOnlyEnabled: all.filter((c) => !ids.includes(c.id) && C.enabled(c.id)).map((c) => c.id),
        gap: C.liteGap('stereo.open'),
      };
    }, LITE_IDS);
    expect(r.profile).toBe('lite');
    expect(r.notImplemented).toEqual([]);
    expect(r.tagged).toEqual([]);
    expect(r.offered).toEqual([]);
    expect(r.fullOnlyEnabled).toEqual([]);
    expect(r.gap).toMatch(/Stereo Panel is in the Full edition only/);
    // Running one says so, as a message and not an error.
    await frame.evaluate(() => window.gisworkbench.commands.run('3d.open'));
    const t = await frame.evaluate(() => window.gisworkbench.toastLog.at(-1));
    expect(t.message).toMatch(/in the Full edition only/);
    expect(t.kind).toBe('info');
    // A module Lite leaves out is refused by name.
    const why = await frame.evaluate(() => window.__gw.runScript('js-three').then(() => 'loaded', (e) => e.message));
    expect(why).toMatch(/GIS Workbench Lite leaves out/);
  });

  test('PT-14 (amended, OD-2.23) Lite has no sidecar: no sidecar UI, commands or loopback origin', async ({ page }) => {
    const { frame, csp } = await lite(page);
    const r = await frame.evaluate(() => ({
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
      loopback: window.__gw.manifest.csp.loopback,
      sidecarUi: [...document.querySelectorAll('[data-id*="sidecar"], [data-cmd^="sidecar."]')].length,
      sidecar: !!window.gisworkbench.sidecar,
      cmds: window.gisworkbench.commands.list().filter((c) => c.id.startsWith('sidecar.') && (c.implemented || window.gisworkbench.commands.enabled(c.id))).map((c) => c.id),
    }));
    expect(r.csp).not.toMatch(/127\.0\.0\.1|localhost/);
    expect(r.loopback).toEqual([]);
    expect(r.sidecarUi).toBe(0);
    expect(r.sidecar).toBe(false);
    expect(r.cmds).toEqual([]);
    expect(await csp()).toEqual([]);
  });

  test('REQ-L10N-14 pseudo-locale (en-XA): every Lite screen is translated', async ({ page }) => {
    test.setTimeout(180_000);
    const { frame } = await lite(page, { network: 'offline', locale: 'en-XA' });
    expect(await frame.evaluate(() => window.gisworkbench.i18n.locale)).toBe('en-XA');
    const leaks = [];
    const sweep = async (where) => {
      const r = await scan(frame, DNT);
      for (const x of r.out) leaks.push(`${where}: ${x.where}: ${x.text}`);
    };
    await sweep('empty');
    await openFiles(frame, [IMAGE]);
    await sweep('image');
    for (const s of ['open', 'measure', 'observe', 'tools']) {
      await page.locator(`[data-id="m:bar:${s}"]`).tap();
      await expect(page.locator('[data-id="m:sheet"]')).toBeVisible();
      await sweep(s);
      await page.locator('[data-id="m:sheet:close"]').tap();
    }
    await page.locator('[data-id="m:bar:layers"]').tap();
    await sweep('layers');
    await page.locator('[data-id="m:layers:close"]').tap();
    const b = await paneBox(page);
    await longPress(page, b.x + b.width / 2, b.y + b.height / 2);
    await expect(page.locator('[data-id="m:point"]')).toBeVisible();
    await sweep('point');
    await page.locator('[data-id="m:sheet:close"]').tap();
    for (const cmd of ['obs.field', 'geo.locate']) {
      await frame.evaluate((c) => {
        window.gisworkbench.commands.run(c);
      }, cmd);
      await frame.waitForSelector('.dlg');
      await sweep(cmd);
      await page.keyboard.press('Escape');
      await frame.waitForFunction(() => !document.querySelector('.dlg'));
    }
    expect(leaks).toEqual([]);
  });

  test('REQ-L10N-14 Lite loads a locale pack as Full does (German) and its sheets follow it', async ({ page }) => {
    const { frame } = await lite(page, { network: 'offline', locale: 'de' });
    const file = readdirSync(join(DIST_DIR, 'packs')).find((f) => /^locale-de-.*\.gwpack$/.test(f));
    test.skip(!file, 'no German pack in this build');
    // Not carried in the file: German comes from its pack, and the app says so until it is open.
    expect(await frame.evaluate(() => [window.gisworkbench.i18n.locale, window.gisworkbench.i18n.needPack])).toEqual(['en', 'locale-de']);
    await frame.evaluate(async ([b, name]) => void (await window.gisworkbench.packs.open(new File([new Uint8Array(b)], name))), [[...readFileSync(join(DIST_DIR, 'packs', file))], file]);
    // Playwright's WebKit context is like a private tab: it cannot store a File in IndexedDB, so the
    // pack lasts this session only. Keeping it across a reload is checked on the simulator.
    if (isWebKit(page)) return;
    await restart(page);
    expect(await frame.evaluate(() => [window.gisworkbench.i18n.locale, document.documentElement.lang])).toEqual(['de', 'de']);
    await page.locator('[data-id="m:bar:measure"]').tap();
    const de = JSON.parse(readFileSync(join(ROOT, 'app', 'src', 'i18n', 'catalog', 'de.json'), 'utf8'));
    await expect(page.locator('[data-id="m:cmd:men.rangebearing"] .m-cmd-label')).toHaveText(de.messages['Range & Bearing']);
  });

  // Measured on this workstation under phone emulation, which does not slow anything down, and again
  // with the CPU slowed 4× as a rough stand-in for a mid-range phone: not a real-phone number.
  // `total` counts from navigation, so it holds the loader stub's unpacking; bootMs starts after it.
  test('REQ-PRF-01 Lite start-up time on the emulated phone (recorded for the validation note)', async ({ context }) => {
    const rows = [];
    for (const rate of [1, 1, 1, 4, 4, 4]) {
      const p = await context.newPage();
      const cdp = await context.newCDPSession(p);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      const { frame } = await lite(p);
      rows.push({ rate, ...(await frame.evaluate(() => ({ app: window.gisworkbench.bootMs, total: Math.round(window.__gw.bootStart + window.gisworkbench.bootMs) }))) });
      await p.close();
    }
    console.log(`Lite boot ms: ${rows.map((r) => `${r.rate}x app ${r.app} total ${r.total}`).join(', ')}`);
    expect(Math.min(...rows.map((r) => r.total))).toBeLessThan(20_000);
  });

  test('REQ-HOST-05 the Lite size gate: at most 5.5 MB, its own app script, smaller than Full', async () => {
    const rep = JSON.parse(readFileSync(join(DIST_DIR, 'build-report.json'), 'utf8'));
    const size = readFileSync(LITE).length;
    expect(size).toBe(rep.sizes.lite);
    expect(size).toBeLessThanOrEqual(5.5 * 1024 * 1024);
    expect(rep.sizes.liteApp).toBeLessThan(rep.sizes.app * 0.6);
    expect(rep.gates.errors).toEqual([]);
    expect(rep.sizes.liteBlocks).not.toContain('js-three');
    expect(rep.sizes.liteBlocks).not.toContain('wasm-photo');
    expect(rep.sizes.liteBlocks).toContain('js-field');
  });
});

test.describe('Full on a phone', () => {
  test.use(as('iPhone 15'));
  test('REQ-HOST-05 the Full file on a phone points to Lite; the user can continue in Full', async ({ page }) => {
    const { frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: { network: 'offline', welcomeDone: true } });
    await frame.waitForSelector('[data-id="dialog:phone-notice"]', { timeout: 15_000 });
    const n = page.locator('[data-id="dialog:phone-notice"]');
    await expect(n).toContainText('GIS Workbench Lite');
    expect(await page.locator('[data-id="phone-notice:lite"]').getAttribute('href')).toBe('gis-workbench-lite.html');
    expect(await axe(frame, '[data-id="dialog:phone-notice"]')).toEqual([]);
    const box = await n.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 0.5);
    await page.locator('[data-id="phone-notice:off"]').check();
    await page.locator('[data-id="dialog:phone-notice"] .dlg-buttons button').first().tap();
    await expect(n).toBeHidden();
    // Full keeps every feature: it is still the desktop GUI.
    expect(await frame.evaluate(() => ({ desktop: !!document.querySelector('.desktop'), profile: window.gisworkbench.commands.profile, stereo: !!window.gisworkbench.commands.get('stereo.open').implemented, pref: window.gisworkbench.prefs.get('phoneNotice') }))).toEqual({ desktop: true, profile: 'full', stereo: true, pref: 'off' });
    // Turned off: not shown at the next start.
    await restart(page);
    await page.waitForTimeout(800);
    expect(await page.locator('[data-id="dialog:phone-notice"]').count()).toBe(0);
  });
});

test('REQ-HOST-05 the Full file on a desktop shows no phone notice; Full has the field tools too', async ({ page }) => {
  const { frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: { network: 'offline', welcomeDone: true } });
  await page.waitForTimeout(800);
  expect(await page.locator('[data-id="dialog:phone-notice"]').count()).toBe(0);
  const r = await frame.evaluate(() => {
    const C = window.gisworkbench.commands;
    return ['geo.locate', 'obs.field', 'obs.export'].map((id) => [id, C.get(id).implemented, C.get(id).profiles.join()]);
  });
  expect(r).toEqual([
    ['geo.locate', true, 'full,lite'],
    ['obs.field', true, 'full,lite'],
    ['obs.export', true, 'full,lite'],
  ]);
  // The notice itself, forced on the desktop, closes with Escape and leaves the preference alone.
  await frame.evaluate(() => {
    window.gisworkbench.phoneNotice({ force: true });
  });
  await frame.waitForSelector('[data-id="dialog:phone-notice"]');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-id="dialog:phone-notice"]')).toHaveCount(0);
  expect(await frame.evaluate(() => window.gisworkbench.prefs.get('phoneNotice'))).toBeUndefined();
});

// The GUI sweeps run in states with no placed observation, so they see Export Observations disabled.
test('REQ-HOST-05 the Full Ribbon: Field Observation enables Export Observations, which saves', async ({ page }) => {
  const { frame, csp } = await openApp(page, 'file', { htmlPath: DIST, prefs: { layout: 'classic', network: 'offline', welcomeDone: true } });
  await openFiles(frame, [IMAGE]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60_000 });
  await frame.evaluate(() => {
    window.__saved = [];
    window.gisworkbench.saveCapture = (blob, name) => window.__saved.push({ blob, name });
  });
  const products = page.locator('section.multiport [data-id="ribbon:tab:products"]').first();
  const item = (id) => page.locator(`section.multiport .ribbon-body [data-id="cmd:${id}"]`).first();
  await products.click();
  await expect(item('obs.export')).toBeDisabled();
  await item('obs.field').click();
  await frame.waitForSelector('[data-id="dialog:field-observation"]');
  await page.locator('[data-id="fobs-text"]').fill('(U) Two vehicles at the gate');
  expect(await page.locator('[data-id="fobs-place"]').inputValue()).toBe('centre');
  await page.locator('[data-id="dialog:field-observation"] .dlg-buttons button').first().click();
  await frame.waitForFunction(() => window.gisworkbench.store.all('observation').length === 1);
  await products.click();
  await expect(item('obs.export')).toBeEnabled();
  await item('obs.export').click();
  await frame.waitForSelector('[data-id="dialog:obs-export"]');
  expect(await axe(frame, '[data-id="dialog:obs-export"]')).toEqual([]);
  await page.locator('[data-id="oexp-format"]').selectOption('geojson');
  await page.locator('[data-id="dialog:obs-export"] .dlg-buttons button', { hasText: /^Save$/ }).click();
  await frame.waitForFunction(() => window.__saved.length === 1);
  const gj = JSON.parse(await frame.evaluate(() => window.__saved[0].blob.text()));
  expect(gj.features.map((f) => f.properties.text)).toEqual(['(U) Two vehicles at the gate']);
  expect(await csp()).toEqual([]);
});

/** Visible text that escaped translation in a pseudo-locale (as tests/e2e/i18n.spec.js scans). */
async function scan(frame, dnt) {
  return frame.evaluate((dnt) => {
    const out = [];
    const ok = (s) => {
      let r = ` ${s} `;
      for (const d of dnt) r = r.split(d).join(' ');
      r = r
        .replace(/\b[\w.-]+\.(ntf|nitf|tif|tiff|json|geojson|png|jpg|kml|kmz|zip|gwpack|html)\b/gi, ' ')
        .replace(/\bfx\d\d\w*/gi, ' ')
        .replace(/\b[A-Z0-9][A-Z0-9_./:-]*\b/g, ' ')
        .replace(/\b\w*\d\w*\b/g, ' ')
        .replace(/\b[a-z]+[A-Z]\w*\b/g, ' ')
        .replace(/\b[a-z]+(\.[a-z]+)+\b/g, ' ');
      return !/[A-Za-z]{4,}/.test(r);
    };
    const visible = (el) => {
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const s = n.nodeValue.trim();
      if (!s) continue;
      const el = n.parentElement;
      if (!el || el.closest('script,style,canvas,textarea,input,select option:not(:checked),.sr-only')) continue;
      if (!visible(el) || el.textContent.includes('⟦') || ok(s)) continue;
      out.push({ text: s.slice(0, 100), where: String(el.closest('[data-id]')?.dataset.id ?? el.className ?? el.tagName).slice(0, 60) });
    }
    for (const el of document.querySelectorAll('[title],[aria-label],[placeholder]')) {
      if (!visible(el)) continue;
      for (const a of ['title', 'aria-label', 'placeholder']) {
        const v = el.getAttribute(a);
        if (!v || v.includes('⟦') || ok(v)) continue;
        out.push({ text: `@${a}: ${v.slice(0, 90)}`, where: el.closest('[data-id]')?.dataset.id ?? el.tagName });
      }
    }
    return { out };
  }, dnt);
}

test.describe('Lite: what leaves the phone, and what survives', () => {
  test.use(as('Pixel 7'));
  const OBS = { text: '(U) Gate', category: 'other', confidence: 'high', lat: 36.001, lon: -114.999, place: 'point', created: '2026-11-04T10:00:00Z', photos: [{ name: 'p.jpg', type: 'image/jpeg', data: 'data:image/jpeg;base64,/9j/2Q==' }] };
  /** An image, one observation, an AOI, a 2 × 2 GRG and a marker. */
  async function work(frame) {
    await openFiles(frame, [IMAGE]);
    await frame.waitForFunction(() => window.gisworkbench.activePane()?.geoLayer?.()?.modelId);
    await frame.evaluate((o) => {
      const app = window.gisworkbench;
      const S = app.store;
      const p = app.activePane();
      app.grg.make({ box: [36, -115, 36 + 0.0018, -115 + 0.0022], cell: 100 });
      const glayer = S.all('graphic')[0].glayer;
      S.transact('field work', (tx) => {
        tx.create('observation', o);
        tx.create('graphic', { glayer, pane: p.id, shape: 'marker', anchor: 'ground', coords: [[-114.999, 36.001, 0]], text: 'Rally', style: {} });
        tx.set(p.id, 'aoi', tx.create('aoi', { pane: p.id, name: 'AOI', anchor: 'ground', coords: [[-115, 36, 0], [-114.998, 36, 0], [-114.998, 36.002, 0], [-115, 36.002, 0]], created: o.created }));
      });
    }, OBS);
  }
  const exportGeoJson = async (page, frame, include) => {
    await frame.evaluate(() => void window.gisworkbench.commands.run('obs.export'));
    await frame.waitForSelector('[data-id="dialog:obs-export"]');
    expect(await axe(frame, '[data-id="dialog:obs-export"]')).toEqual([]);
    await page.locator('[data-id="oexp-format"]').selectOption('geojson');
    await page.locator('[data-id="oexp-scene"]').setChecked(include);
    await page.locator('[data-id="dialog:obs-export"] .dlg-buttons button', { hasText: /^Save$/ }).tap();
    await frame.waitForFunction((n) => window.__saved.length === n, include ? 1 : 2);
    return JSON.parse(await frame.evaluate((k) => window.__saved[k].blob.text(), include ? 0 : 1));
  };

  test('REQ-HOST-05 Export Observations carries the AOI, GRG and annotations, and can leave them out', async ({ page }) => {
    const { frame } = await lite(page);
    await work(frame);
    const all = await exportGeoJson(page, frame, true);
    const counts = (g) => g.features.reduce((m, f) => ((m[f.properties.kind ?? 'observation'] = (m[f.properties.kind ?? 'observation'] ?? 0) + 1), m), {});
    const cells = all.features.filter((f) => f.properties.kind === 'graphic' && f.geometry.type === 'Polygon');
    expect(cells.map((f) => f.properties.name).sort()).toEqual(['A1', 'A2', 'B1', 'B2']);
    expect(counts(all)).toEqual({ observation: 1, aoi: 1, graphic: 5 }); // each GRG label once, on its cell
    expect(all.features.find((f) => f.properties.kind === 'aoi').geometry.coordinates[0].length).toBe(5);
    const only = await exportGeoJson(page, frame, false);
    expect(counts(only)).toEqual({ observation: 1 });
  });

  test('REQ-HOST-05 the field work survives a reload: Recover brings it back', async ({ page }) => {
    const { frame } = await lite(page);
    await work(frame);
    await page.waitForTimeout(2500); // the journal writes on a timer
    await restart(page);
    expect(await frame.evaluate(() => window.gisworkbench.store.all('observation').length)).toBe(0);
    await page.locator('button', { hasText: /^Recover$/ }).tap();
    await frame.waitForFunction(() => window.gisworkbench.store.all('observation').length === 1);
    const back = await frame.evaluate(() => {
      const S = window.gisworkbench.store;
      return { obs: S.all('observation')[0], graphics: S.all('graphic').length, aoi: S.all('aoi').length };
    });
    expect(back.obs.text).toBe(OBS.text);
    expect(back.obs.photos[0].data).toBe(OBS.photos[0].data);
    expect(back.graphics).toBe(9);
    expect(back.aoi).toBe(1);
    expect(await page.locator('.m-view .pane').count()).toBeGreaterThan(0);
    expect(await frame.evaluate(() => window.gisworkbench.store.all('layer').length)).toBe(1); // its image waits to be relinked
  });

  test('REQ-ARC-19 Lite offers Export Snapshot, and the snapshot reopens with the work and its image', async ({ page, context }, info) => {
    const { frame } = await lite(page);
    await work(frame);
    await page.locator('[data-id="m:bar:observe"]').tap();
    await page.locator('[data-id="m:cmd:file.snapshot"]').tap();
    await frame.waitForFunction(() => window.__saved.length === 1);
    const saved = await frame.evaluate(async () => ({ name: window.__saved[0].name, html: await window.__saved[0].blob.text() }));
    expect(saved.name).toMatch(/-snapshot\.html$/);
    const file = info.outputPath('snapshot.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, saved.html);
    const again = await context.newPage();
    const { frame: f2 } = await openApp(again, 'file', { htmlPath: file, prefs: { network: 'offline' } });
    await f2.waitForFunction(() => window.gisworkbench.store.all('observation').length === 1, null, { timeout: 60_000 });
    await f2.waitForFunction(() => window.gisworkbench.snapshotInfo);
    expect(await f2.evaluate(() => [window.gisworkbench.commands.profile, window.gisworkbench.store.all('graphic').length, window.gisworkbench.snapshotInfo.files])).toEqual(['lite', 9, 1]);
  });
});

// SCN-75 (REQ-GAP-86, OD-2.40): a field survey in Lite saved as a project, finished in Full, and
// reopened in Lite under phone emulation; then back in Full with nothing lost. Lite's Save and Open
// Project are on its Open sheet; Lite names what only Full shows and keeps it.
test.describe('Lite: the project file goes to Full and back', () => {
  test.use(as('Pixel 7'));
  const OBS = (text, lon) => ({ text, category: 'other', confidence: 'high', lat: 36.001, lon, place: 'point', created: '2026-11-08T10:00:00Z', photos: [] });
  const saveFromLite = async (page, frame) => {
    const before = await frame.evaluate(() => window.__saved.length);
    await openSheet(page, 'open');
    await page.locator('[data-id="m:cmd:file.save"]').tap();
    await frame.waitForFunction((n) => window.__saved.length === n + 1, before);
    return frame.evaluate(async () => {
      const s = window.__saved.at(-1);
      return { name: s.name, b64: btoa(String.fromCharCode(...new Uint8Array(await s.blob.arrayBuffer()))) };
    });
  };
  /** Full on a desktop (no phone emulation) with the project open; WebKit reads it over loopback, as Lite. */
  let fullServer;
  const inFull = async (browser, b64) => {
    const ctx = await browser.newContext();
    const webkit = browser.browserType().name() === 'webkit';
    if (webkit) fullServer ??= await servers(DIST);
    const { frame, logs } = await openApp(await ctx.newPage(), webkit ? 'http' : 'file', { srv: fullServer, htmlPath: DIST });
    await frame.evaluate(async (b64) => {
      const app = window.gisworkbench;
      app.relinkPick = 'skip';
      await app.openProjectFile(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'survey.gwb'));
    }, b64);
    return { ctx, frame, logs };
  };

  test('SCN-75 REQ-GAP-86 a Lite survey saved as a project, finished in Full, reopened in Lite', async ({ page, browser, context }) => {
    test.setTimeout(240000);
    // 1. The survey in Lite: an image, an observation, a GRG, a marker and an AOI; saved from the Open sheet.
    const { frame, logs } = await lite(page);
    await openFiles(frame, [IMAGE]);
    await frame.waitForFunction(() => window.gisworkbench.activePane()?.geoLayer?.()?.modelId);
    await frame.evaluate((o) => {
      const app = window.gisworkbench;
      const S = app.store;
      const p = app.activePane();
      app.grg.make({ box: [36, -115, 36 + 0.0018, -115 + 0.0022], cell: 100 });
      const glayer = S.all('graphic')[0].glayer;
      S.transact('field work', (tx) => {
        tx.create('observation', o);
        tx.create('graphic', { glayer, pane: p.id, shape: 'marker', anchor: 'ground', coords: [[-114.999, 36.001, 0]], text: 'Rally', style: {} });
        tx.set(p.id, 'aoi', tx.create('aoi', { pane: p.id, name: 'AOI', anchor: 'ground', coords: [[-115, 36, 0], [-114.998, 36, 0], [-114.998, 36.002, 0], [-115, 36.002, 0]], created: o.created }));
      });
    }, OBS('Gate', -114.999));
    const first = await saveFromLite(page, frame);
    expect(first.name).toMatch(/\.gwb$/);
    // 2. Finished in Full: a second observation, a TIN (a Full-only record), a second panel, a second
    // Multiport and a dock moved; saved.
    const F1 = await inFull(browser, first.b64);
    const out1 = await F1.frame.evaluate(async () => {
      const app = window.gisworkbench;
      const S = app.store;
      const got = { obs: S.all('observation').length, graphics: S.all('graphic').length, aoi: S.all('aoi').length, layers: S.all('layer').length };
      S.transact('desk work', (tx) => tx.create('observation', { text: 'Culvert', category: 'other', confidence: 'high', lat: 36.0012, lon: -114.9985, place: 'point', created: '2026-11-08T12:00:00Z', photos: [] }));
      const rows = ['lon,lat,z'];
      for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) rows.push(`${(-115 + i * 3e-4).toFixed(6)},${(36 + j * 3e-4 + i * 1e-5).toFixed(6)},${(600 + i + j * 0.5).toFixed(2)}`);
      const { id } = await app.tin.importFile(new File([rows.join('\n')], 'site.csv'), { vertical: 'hae' });
      const tri = (await app.tin.info(id)).triangles;
      const mp1 = app.desktop.multiports[0];
      mp1.setLayout('1x2');
      await app.commands.run('win.new');
      const dock = [...mp1.docks.registry.keys()].find((k) => !mp1.docks.registry.get(k).transient && !mp1.docks.isOpen?.(k));
      mp1.docks.show(dock, 'right');
      const b = app.__test.serialiseProject(app);
      const { views } = app.__test.readProject(b);
      let bin = '';
      for (let k = 0; k < b.length; k += 8192) bin += String.fromCharCode(...b.subarray(k, k + 8192));
      return { got, tin: id, tri, b64: btoa(bin), views, first: mp1.panes[0].id };
    });
    expect(out1.got).toEqual({ obs: 1, graphics: 9, aoi: 1, layers: 1 });
    expect(out1.tri).toBeGreaterThan(10);
    expect([Object.keys(out1.views.views).length, Object.keys(out1.views.docks).length]).toEqual([3, 2]);
    expect(F1.logs).toEqual([]);
    await F1.ctx.close();
    // 3. Reopened in Lite on the phone through Open Project: the work is there, the TIN is named and kept.
    const page2 = await context.newPage();
    const { frame: f2, logs: logs2 } = await lite(page2);
    await f2.evaluate(() => Object.assign(window.gisworkbench, { relinkPick: 'skip' }).runMode.caps.fsaPicker = false);
    await openSheet(page2, 'open');
    const [fc] = await Promise.all([page2.waitForEvent('filechooser'), page2.locator('[data-id="m:cmd:file.openproject"]').tap()]);
    await fc.setFiles({ name: 'survey.gwb', mimeType: 'application/zip', buffer: Buffer.from(out1.b64, 'base64') });
    await f2.waitForFunction(() => window.gisworkbench.store.all('observation').length === 2);
    await expect(page2.locator('.toast', { hasText: 'TIN surfaces' })).toBeVisible();
    const inLite = await f2.evaluate(() => {
      const app = window.gisworkbench;
      const S = app.store;
      return { obs: S.all('observation').map((o) => o.text).sort(), tin: S.all('tin').length, graphics: S.all('graphic').length, profile: app.commands.profile, ports: app.desktop.multiports.length, note: app.importLog.at(-1).warnings.join(' ') };
    });
    // One port and one panel shown; the TIN and the two other panels are named, and kept.
    expect(inLite).toMatchObject({ obs: ['Culvert', 'Gate'], tin: 1, graphics: 9, profile: 'lite', ports: 1 });
    expect(inLite.note).toMatch(/TIN surfaces/);
    expect(inLite.note).toMatch(/2 more panels/);
    // A third observation in the field, and save again.
    await f2.evaluate((o) => window.gisworkbench.store.transact('more field work', (tx) => tx.create('observation', o)), OBS('Washout', -114.9988));
    const second = await saveFromLite(page2, f2);
    // Crash recovery in Lite shows one port too: a change after the save, a reload, then Recover.
    await f2.evaluate((o) => window.gisworkbench.store.transact('after the save', (tx) => tx.create('observation', o)), OBS('Rut', -114.9989));
    await page2.waitForTimeout(2500); // the journal writes on a timer
    const f3 = await restart(page2);
    await page2.locator('button', { hasText: /^Recover$/ }).tap();
    await f3.waitForFunction(() => window.gisworkbench.store.all('observation').some((o) => o.text === 'Rut'));
    expect(await f3.evaluate(() => [window.gisworkbench.store.all('multiport').length, window.gisworkbench.desktop.multiports.length])).toEqual([2, 1]);
    expect(await page2.locator('.m-view .pane').count()).toBe(1);
    // 4. Back in Full: all three observations, and the TIN still builds with its triangles.
    const F2 = await inFull(browser, second.b64);
    const back = await F2.frame.evaluate(async () => {
      const app = window.gisworkbench;
      const S = app.store;
      const id = S.all('tin')[0]?.id;
      await app.tin.ready(id);
      return { obs: S.all('observation').map((o) => o.text).sort(), graphics: S.all('graphic').length, aoi: S.all('aoi').length, tri: (await app.tin.info(id)).triangles, ports: app.desktop.multiports.length };
    });
    expect(back).toEqual({ obs: ['Culvert', 'Gate', 'Washout'], graphics: 9, aoi: 1, tri: out1.tri, ports: 2 });
    // Full's panels, docks and arrangement came back through Lite as they were; Lite saved its own view of the first panel.
    const kept = await F2.frame.evaluate((b64) => window.gisworkbench.__test.readProject(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))).views, second.b64);
    expect(kept.docks).toEqual(out1.views.docks);
    expect(kept.arrange).toBe(out1.views.arrange);
    expect(Object.keys(kept.views).sort()).toEqual(Object.keys(out1.views.views).sort());
    for (const [id, v] of Object.entries(out1.views.views)) if (id !== out1.first) expect(kept.views[id], id).toEqual(v);
    expect(F2.logs).toEqual([]);
    await F2.ctx.close();
    expect(logs).toEqual([]);
    expect(logs2).toEqual([]);
  });
});
