// Android Chrome through adb: Chrome is started by an intent and driven over its DevTools socket.
// Playwright's _android.launchBrowser needs Chrome's command line, which a user build ignores
// unless a chrome://flags switch is on, so this connects to the running browser instead.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const SDK = process.env.ANDROID_HOME ?? 'C:\\Android\\Sdk';
const ADB = join(SDK, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const CHROME = 'com.android.chrome';
const CDP_PORT = 9222;
export const PORT = 8765;
export const ORIGIN = `http://localhost:${PORT}`;
export const SHOTS = join('reports', 'android', 'shots');
export const REMOTE_FILE = '/sdcard/Download/gis-workbench-lite.html';

// With a timeout: a stuck adb call blocks the worker, so Playwright's own timeout could not fire.
export const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'], timeout: 40_000 });
export const sh = (cmd) => adb('shell', cmd);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The device's screen as a PNG in reports/android/shots. */
export function shot(name) {
  mkdirSync(SHOTS, { recursive: true });
  const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 1 << 26, timeout: 40_000 });
  const file = join(SHOTS, `${name}.png`);
  writeFileSync(file, png);
  return file;
}

/** The on-screen nodes (uiautomator): text, description, id and bounds in device pixels. */
export function ui() {
  for (let i = 0; ; i++) {
    try {
      sh('uiautomator dump /sdcard/ui.xml');
      break;
    } catch (e) {
      if (i === 3) throw e; // it refuses while the screen is still settling after a start
      execFileSync('ping', ['-n', '2', '127.0.0.1']);
    }
  }
  const xml = sh('cat /sdcard/ui.xml');
  return [...xml.matchAll(/<node [^>]*>/g)].map(([n]) => {
    const a = (k) => n.match(new RegExp(` ${k}="([^"]*)"`))?.[1] ?? '';
    const [x0, y0, x1, y1] = (a('bounds').match(/\d+/g) ?? [0, 0, 0, 0]).map(Number);
    return { text: a('text'), desc: a('content-desc'), id: a('resource-id'), pkg: a('package'), x0, y0, x1, y1, cx: (x0 + x1) >> 1, cy: (y0 + y1) >> 1 };
  });
}

export const findUi = (re, nodes = ui()) => nodes.find((n) => re.test(n.text) || re.test(n.desc));

/** Tap an on-screen node by its text or description, waiting for it to appear. */
export async function tapUi(re, { timeout = 15_000 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const n = findUi(re);
    if (n) {
      sh(`input tap ${n.cx} ${n.cy}`);
      return n;
    }
    if (Date.now() > end) throw new Error(`no on-screen ${re}`);
    await sleep(500);
  }
}

/** Device pixels of a CSS point: below Chrome's toolbar, at the page's scale. */
export async function toDevice(page, x, y) {
  const dpr = await page.evaluate(() => devicePixelRatio);
  const bar = ui().find((n) => n.id === `${CHROME}:id/control_container`);
  return [Math.round(x * dpr), Math.round(y * dpr + (bar?.y1 ?? 0))];
}

/** A real finger: goes through Android's input stack, as a phone's does. */
export async function fingerTap(page, x, y) {
  const [dx, dy] = await toDevice(page, x, y);
  sh(`input tap ${dx} ${dy}`);
}
export async function fingerTapOn(locator) {
  await locator.scrollIntoViewIfNeeded(); // a dialog scrolls once the on-screen keyboard shrinks the page
  await sleep(300);
  const b = await locator.boundingBox();
  if (!b) throw new Error('nothing to tap');
  await fingerTap(locator.page(), b.x + b.width / 2, b.y + b.height / 2);
}
export async function fingerSwipe(page, x0, y0, x1, y1, ms = 300) {
  const a = await toDevice(page, x0, y0);
  const b = await toDevice(page, x1, y1);
  sh(`input swipe ${a[0]} ${a[1]} ${b[0]} ${b[1]} ${ms}`);
}
export async function fingerHold(page, x, y, ms = 800) {
  return fingerSwipe(page, x, y, x, y, ms);
}

/** Chrome's own processes' memory, kB of PSS by process. */
export function chromeMemory() {
  const out = sh('dumpsys meminfo');
  const rows = [...out.matchAll(/([\d,]+)K: (com\.android\.chrome[^\s]*)/g)].map((m) => [m[2], Number(m[1].replace(/,/g, ''))]);
  return Object.fromEntries(rows);
}

export function deviceFacts() {
  const prop = (k) => sh(`getprop ${k}`).trim();
  return { android: prop('ro.build.version.release'), sdk: prop('ro.build.version.sdk'), abi: prop('ro.product.cpu.abi'), model: prop('ro.product.model'), chrome: sh(`dumpsys package ${CHROME}`).match(/versionName=(\S+)/)?.[1], wm: sh('wm size').trim() };
}

/**
 * Browser and page in a new tab at `url`. Close with `.close()`; that leaves Chrome running.
 * `cold` restarts Chrome first. Only tests that need it do: the emulator hung or crashed in Chrome's
 * GPU start-up (the last thing in its log was always a guest VkInstance), so tabs go and Chrome stays.
 */
export async function startChrome(url, { cold = false } = {}) {
  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
  adb('forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote');
  sh('input keyevent 3'); // home: nothing left over from an earlier test sits on top of Chrome
  const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => []);
  for (const t of list.filter((x) => x.type === 'page')) await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${t.id}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
  if (cold) {
    await sleep(1500); // Chrome's GPU process goes idle first: killing it mid-frame has taken the emulator down
    sh(`am force-stop ${CHROME}`);
    await sleep(1000);
  }
  const started = Date.now();
  sh(`am start -a android.intent.action.VIEW -d '${url}' ${CHROME}`);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  // `pm revoke` kills Chrome, and just after that restart its DevTools socket can answer and then drop.
  let browser;
  for (let i = 0; !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch (e) {
      if (i >= 8) throw e;
      await sleep(1000);
    }
  }
  // Playwright routes downloads to a folder on this computer, which fails every download on the device.
  await (await browser.newBrowserCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'default' });
  const context = browser.contexts()[0];
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = context.pages().find((p) => p.url() === url);
    if (!page) await sleep(250);
  }
  if (!page) throw new Error(`no tab at ${url}: ${context.pages().map((p) => p.url()).join(', ')}`);
  for (const p of context.pages()) if (p !== page) await p.close().catch(() => {});
  return { browser, context, page, started };
}

/** Capture what the app logs as errors. */
export function watch(page) {
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(m.text());
  });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  return logs;
}

export const ready = (page) => page.waitForFunction(() => document.body?.dataset.ready, null, { timeout: 60_000 });

/** Lite with empty storage and these preferences, from a page of the same origin that holds nothing open. */
export async function openLite({ prefs = { network: 'offline' }, keep = false } = {}) {
  const s = await startChrome(`${ORIGIN}/__loader`);
  await s.page.evaluate(
    async ([prefs, keep]) => {
      if (!keep) {
        localStorage.clear();
        await Promise.all((await indexedDB.databases()).map((d) => new Promise((r) => {
          const q = indexedDB.deleteDatabase(d.name);
          q.onsuccess = q.onerror = q.onblocked = r;
        })));
      }
      localStorage.setItem('gisworkbench.prefs.v1', JSON.stringify(prefs));
    },
    [prefs, keep],
  );
  const logs = watch(s.page);
  await s.page.goto(`${ORIGIN}/gis-workbench-lite.html`);
  await ready(s.page);
  expect(await s.page.evaluate(() => document.body.dataset.ready)).toBe('1');
  return { ...s, logs };
}
