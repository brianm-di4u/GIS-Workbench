// Safari in the iOS Simulator, for GIS Workbench Lite (OD-2.23, REQ-HOST-05). Runs on a macOS host
// with Xcode and Appium's XCUITest driver: see .github/workflows/lite-ios-sim.yml. Playwright cannot
// drive this Safari, so this is a small WebDriver client over fetch, plus `xcrun simctl`. Web content
// is read in Safari's web context; touches go through the native context, so they arrive through
// iOS's own input stack and not as events a script made up.

import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const ORIGIN = 'http://127.0.0.1:8765';
export const LITE_URL = `${ORIGIN}/gis-workbench-lite.html`;
export const OUT = join('reports', 'ios');
const APPIUM = process.env.GW_APPIUM ?? 'http://127.0.0.1:4723';
const UDID = process.env.GW_SIM_UDID;
const METRICS = join(OUT, 'metrics.json');
mkdirSync(join(OUT, 'shots'), { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8', timeout: 150_000 }).trim();

const metrics = existsSync(METRICS) ? JSON.parse(readFileSync(METRICS, 'utf8')) : {};
export function note(k, v) {
  metrics[k] = v;
  writeFileSync(METRICS, JSON.stringify(metrics, null, 1));
}

/** Plain http, not fetch: a first session builds WebDriverAgent, past fetch's five-minute header limit. */
function http(method, path, body) {
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const q = request(`${APPIUM}${path}`, { method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (r.statusCode >= 400) reject(new Error(`${method} ${path}: ${j?.value?.error ?? r.statusCode}: ${String(j?.value?.message ?? '').slice(0, 400)}`));
        else resolve(j.value);
      });
    });
    q.setTimeout(1_500_000, () => q.destroy(new Error(`${method} ${path}: no answer in 25 minutes`)));
    q.on('error', reject);
    q.end(data ?? undefined);
  });
}

const elementId = (v) => v['element-6066-11e4-a52e-4f735466cecf'] ?? v.ELEMENT;

let current = null;

export class Safari {
  static async start() {
    // Just after another session, Safari's remote debugger can list no page. Appium then fails the
    // whole session, and every test goes with it, so a new session is worth one more try.
    let value;
    for (let i = 0; !value; i++) {
      try {
        value = await Safari.session();
      } catch (e) {
        if (i >= 2 || !/remote debugger/.test(e.message)) throw e;
      }
    }
    const s = new Safari();
    s.id = value.sessionId;
    s.caps = value.capabilities;
    s.path = `/session/${s.id}`;
    await s.cmd('POST', '/timeouts', { script: 180_000 });
    s.web = await s.findWeb();
    current = s;
    await s.tapNative(['Close'], { timeout: 1500 }).catch(() => null); // Safari's first-run tip
    return s;
  }

  static session() {
    return http('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          platformName: 'iOS',
          browserName: 'Safari',
          'appium:automationName': 'XCUITest',
          'appium:udid': UDID,
          'appium:noReset': true, // this suite clears the app's own storage; a kill must leave it in place for the recovery test
          'appium:connectHardwareKeyboard': false, // the on-screen keyboard
          'appium:safariInitialUrl': `${ORIGIN}/__loader`,
          'appium:showSafariConsoleLog': true,
          'appium:nativeWebScreenshot': true,
          'appium:isHeadless': true, // otherwise Appium restarts the booted simulator to show its window
          'appium:simulatorStartupTimeout': 600_000, // a hosted runner's first boot is slow
          'appium:wdaLaunchTimeout': 480_000,
          'appium:newCommandTimeout': 300,
          'appium:webviewConnectTimeout': 60_000,
        },
      },
    });
  }

  cmd(method, p, body) {
    return http(method, `${this.path}${p}`, body);
  }

  async findWeb() {
    for (let i = 0; i < 60; i++) {
      const web = (await this.cmd('GET', '/contexts')).filter((c) => c !== 'NATIVE_APP');
      if (web.length) return web.at(-1);
      await sleep(1000);
    }
    throw new Error('no web context in Safari');
  }

  async inWeb() {
    await this.cmd('POST', '/context', { name: this.web });
  }

  async inNative() {
    await this.cmd('POST', '/context', { name: 'NATIVE_APP' });
  }

  async stop() {
    await this.cmd('DELETE', '').catch(() => {});
  }

  /**
   * Run a function, given as source text, in the page. It gets `args` and may return a promise.
   * Safari's `stack` leaves out the message (an anonymous frame is just "@"), so an error is
   * reported as its name and message, then its stack (#195).
   */
  async js(fn, ...args) {
    const r = await this.cmd('POST', '/execute/async', {
      script: `const done = arguments[arguments.length - 1]; const args = [...arguments].slice(0, -1);
        Promise.resolve().then(() => (${fn}).apply(null, args)).then((v) => done({ ok: v === undefined ? null : v }), (e) => done({ err: e && typeof e === 'object' ? [String(e.name || 'Error') + ': ' + String(e.message || ''), e.stack].filter(Boolean).join(' at ') : String(e) }));`,
      args,
    });
    if (r?.err) throw new Error(`in page: ${r.err}`);
    return r?.ok;
  }

  async go(url) {
    await this.cmd('POST', '/url', { url });
  }

  async until(fn, { timeout = 30_000, args = [], what = 'a condition' } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = await this.js(fn, ...args).catch((e) => {
        if (/in page/.test(e.message)) return false;
        throw e;
      });
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(250);
    }
  }

  ready() {
    return this.until('() => document.body && document.body.dataset.ready', { timeout: 90_000, what: 'the app to report ready' });
  }

  /** Lite from clean storage (or as it is, with keep), offline by preference. */
  async openLite({ prefs = { network: 'offline' }, keep = false } = {}) {
    await this.inWeb();
    await this.go(`${ORIGIN}/__loader`);
    await this.js(
      `async (prefs, keep) => {
        if (!keep) {
          localStorage.clear();
          await Promise.all((await indexedDB.databases()).map((d) => new Promise((r) => {
            const q = indexedDB.deleteDatabase(d.name);
            q.onsuccess = q.onerror = q.onblocked = r;
          })));
        }
        localStorage.setItem('gisworkbench.prefs.v1', JSON.stringify(prefs));
      }`,
      prefs,
      keep,
    );
    await this.go(LITE_URL);
    const r = await this.ready();
    if (String(r) !== '1') {
      // Lite says why on the page: missing WebGL2 or WebAssembly, or the error boot threw (#185).
      // What the page can do now, and its console, tell a cold-start condition from a Lite fault (#195).
      const why = await this.js(`() => ({
        page: document.getElementById('app')?.innerText.slice(0, 400),
        runmode: document.documentElement.dataset.runmode ?? null,
        webgl2: !!document.createElement('canvas').getContext('webgl2'),
        wasm: typeof WebAssembly === 'object',
        sinceLoad: Math.round(performance.now()),
      })`).catch((e) => ({ error: e.message }));
      const logs = await this.consoleErrors();
      note('startFailure', { ready: r, ...why, console: logs });
      await shot('start-failure');
      throw new Error(`the app did not start: ready=${r}; the page says: ${JSON.stringify(why)}; console: ${JSON.stringify(logs.slice(-5))}`);
    }
  }

  /** The image, sent through the driver in pieces: the app's connect-src allows only blob:. */
  async openImage(path = join('fixtures', 'fx01', 'fx01.ntf'), name = 'fx01.ntf') {
    const buf = readFileSync(path);
    await this.js('() => { window.__parts = []; }');
    const step = 3 * 1024 * 1024; // a multiple of 3, so every piece is whole base64
    for (let i = 0; i < buf.length; i += step) await this.js('(b) => { window.__parts.push(b); }', buf.subarray(i, i + step).toString('base64'));
    await this.js(
      `async (name) => {
        const parts = window.__parts.map((b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
        delete window.__parts;
        await window.gisworkbench.openFiles([new File(parts, name)]);
      }`,
      name,
    );
    await this.until(visible('m:readout'), { timeout: 90_000, what: 'the image readout' });
  }

  box(selector) {
    return this.js(
      `(s) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }`,
      selector,
    );
  }

  async find(using, value) {
    return elementId(await this.cmd('POST', '/element', { using, value }));
  }

  async findAll(using, value) {
    return (await this.cmd('POST', '/elements', { using, value })).map(elementId);
  }

  /**
   * Where page point (0, 0) is on the screen, in points. Safari 26's web view runs under its bars, so
   * its frame does not say. A small labelled button shows it: iOS reports where that really is.
   */
  async origin() {
    const key = await this.js('() => `${innerWidth}x${innerHeight}`');
    if (this.calibrated?.key === key) return this.calibrated;
    await this.js(`() => {
      const b = document.createElement('button');
      b.id = 'gw-calibrate';
      b.setAttribute('aria-label', 'gw-calibrate');
      b.style.cssText = 'position:fixed;left:100px;top:200px;width:60px;height:60px;z-index:2147483647;opacity:0.01';
      document.body.appendChild(b);
    }`);
    await sleep(500);
    await this.inNative();
    try {
      // The button reaches the accessibility tree some time after it is added; 500 ms was not
      // always enough on the runner (#185).
      let id;
      for (const end = Date.now() + 5000; !id; await sleep(250)) {
        [id] = await this.findAll('-ios predicate string', `label == "gw-calibrate"`);
        if (!id && Date.now() > end) throw new Error('the calibration button never reached the accessibility tree');
      }
      const r = await this.cmd('GET', `/element/${id}/rect`);
      this.calibrated = { key, x: r.x - 100, y: r.y - 200 };
      note('page-origin', this.calibrated);
      return this.calibrated;
    } finally {
      await this.inWeb();
      await this.js(`() => document.getElementById('gw-calibrate')?.remove()`);
    }
  }

  /** Each finger is a start [x, y] then legs of [x, y, ms] or [null, null, ms] to stay put; page points. */
  async touch(fingers) {
    const o = await this.origin();
    const at = (x, y) => ({ x: Math.round(o.x + x), y: Math.round(o.y + y) });
    const actions = fingers.map((legs, i) => ({
      type: 'pointer',
      id: `f${i}`,
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, ...at(legs[0][0], legs[0][1]) },
        { type: 'pointerDown', button: 0 },
        ...legs.slice(1).map(([x, y, ms]) => (x === null ? { type: 'pause', duration: ms } : { type: 'pointerMove', duration: ms, ...at(x, y) })),
        { type: 'pointerUp', button: 0 },
      ],
    }));
    await this.inNative();
    try {
      await this.cmd('POST', '/actions', { actions });
    } finally {
      await this.inWeb();
    }
  }

  tap(x, y) {
    return this.touch([[[x, y], [null, null, 60]]]);
  }

  async tapOn(selector) {
    const b = await this.box(selector);
    if (!b) throw new Error(`nothing to tap: ${selector}`);
    await this.tap(b.x + b.width / 2, b.y + b.height / 2);
  }

  hold(x, y, ms = 900) {
    return this.touch([[[x, y], [null, null, ms]]]);
  }

  swipe(x0, y0, x1, y1, ms = 350) {
    return this.touch([[[x0, y0], [x1, y1, ms]]]);
  }

  /** The tree iOS is showing, for finding its dialogs and sheets. */
  async nativeSource() {
    await this.inNative();
    try {
      return await this.cmd('GET', '/source');
    } finally {
      await this.inWeb();
    }
  }

  /** Tap the first native button with one of these labels. Returns its label, or null. */
  // anyType: match the label on any element. The Files picker's tab bar on iOS 26.5 is not made of
  // buttons, so a button-only search never finds its Browse tab.
  async tapNative(labels, { timeout = 10_000, anyType = false } = {}) {
    const byLabel = `(${labels.map((l) => `label == "${l}"`).join(' OR ')})`;
    const q = anyType ? byLabel : `type == 'XCUIElementTypeButton' AND ${byLabel}`;
    await this.inNative();
    try {
      const end = Date.now() + timeout;
      for (;;) {
        const [id] = await this.findAll('-ios predicate string', q);
        if (id) {
          const label = await this.cmd('GET', `/element/${id}/attribute/label`);
          await this.cmd('POST', `/element/${id}/click`, {});
          return label;
        }
        if (Date.now() > end) return null;
        await sleep(400);
      }
    } finally {
      await this.inWeb();
    }
  }

  /** Answer an alert iOS itself shows (they belong to SpringBoard, so a Safari search misses them). */
  async acceptAlert(labels) {
    await this.inNative();
    try {
      for (const buttonLabel of labels) {
        const done = await this.cmd('POST', '/execute/sync', { script: 'mobile: alert', args: [{ action: 'accept', buttonLabel }] }).then(() => true, () => false);
        if (done) return buttonLabel;
      }
      return null;
    } finally {
      await this.inWeb();
    }
  }

  async doubleTap(x, y) {
    const o = await this.origin();
    await this.inNative();
    try {
      await this.cmd('POST', '/execute/sync', { script: 'mobile: doubleTap', args: [{ x: Math.round(o.x + x), y: Math.round(o.y + y) }] });
    } finally {
      await this.inWeb();
    }
  }

  async rotate(orientation) {
    this.calibrated = null;
    await this.inNative();
    try {
      await this.cmd('POST', '/orientation', { orientation });
    } finally {
      await this.inWeb();
    }
  }

  async consoleErrors() {
    const logs = await this.cmd('POST', '/se/log', { type: 'safariConsole' }).catch(() => []);
    return logs.filter((l) => /error/i.test(JSON.stringify(l.level ?? l.message?.level ?? ''))).map((l) => (typeof l.message === 'string' ? l.message : JSON.stringify(l.message)).slice(0, 300));
  }
}

/** A page function, as source text: the element with this data-id is on screen. */
export const visible = (id) => `() => { const e = document.querySelector('[data-id="${id}"]'); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; }`;

/** The whole screen, through the driver: `simctl io` stalled for minutes on a loaded runner. */
export async function shot(name) {
  const file = join(OUT, 'shots', `${name}.png`);
  try {
    writeFileSync(file, Buffer.from(await current.cmd('GET', '/screenshot'), 'base64'));
  } catch (e) {
    console.log(`no screenshot ${name}: ${e.message}`); // evidence only: the check goes on
  }
  return file;
}

export function deviceFacts(s) {
  const { devices } = JSON.parse(simctl('list', 'devices', '--json'));
  const hit = Object.entries(devices).flatMap(([rt, ds]) => ds.map((d) => ({ ...d, runtime: rt }))).find((d) => d.udid === UDID);
  return { device: hit?.name, runtime: hit?.runtime?.split('.').pop(), udid: UDID, xcode: execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' }).replace(/\n/g, ' ').trim(), platformVersion: s.caps?.platformVersion };
}
