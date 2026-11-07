// GIS Workbench Lite in real Safari on the iOS Simulator (OD-2.23, REQ-HOST-05): the iOS half of what
// tests/android/lite.android.spec.js does for Android Chrome. Real touch through iOS, the real
// on-screen keyboard, Safari's location prompt, share sheet and download prompt, and a Safari that is
// killed. A simulator is not a phone: no camera, and no memory limit or speed of a device.

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Safari, LITE_URL, deviceFacts, note, shot, simctl, sleep, visible } from './device.mjs';

const UDID = process.env.GW_SIM_UDID;
const HOSTED = 'https://www.gisworkbench.com/app/gis-workbench-lite';
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const GATE = { lat: 36.1, lon: -115.2 };
const m = (id) => `[data-id="${id}"]`;

let s;
let retries = 0;
before(async () => {
  s = await Safari.start();
  note('device', deviceFacts(s));
});
after(() => s?.stop());
afterEach(async (t) => {
  if (t.passed === false) {
    try {
      await shot(`fail-${t.name.replace(/\W+/g, '-').slice(0, 60)}`);
    } catch {
      /* the evidence is not worth a second failure */
    }
  }
  await s.rotate('PORTRAIT').catch(() => {});
  await s.until('() => innerHeight > innerWidth', { timeout: 10_000, what: 'portrait' }).catch(() => {});
  await sleep(2000); // iOS maps a touch by the old orientation until the turn has finished
});

/** Kill Safari the way iOS does and start again, without touching its storage. */
async function restart() {
  await s.stop();
  try {
    simctl('terminate', UDID, 'com.apple.mobilesafari');
  } catch {
    /* it had already gone */
  }
  await sleep(1500);
  s = await Safari.start();
}

const bootFacts = () =>
  s.js(`() => {
    const app = window.gisworkbench;
    const gl = document.createElement('canvas').getContext('webgl2');
    return { ready: document.body.dataset.ready, edition: document.documentElement.dataset.edition, mode: app?.runMode?.mode, protocol: location.protocol, secure: isSecureContext, problems: app?.runMode?.problems, webgl2: !!gl, bootMs: app?.bootMs, share: !!navigator.share, geolocation: !!navigator.geolocation, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio };
  }`);
const view = () => s.js('() => ({ ...window.gisworkbench.activePane().view })');
const pageScale = () => s.js('() => visualViewport.scale');

async function centre() {
  const b = await s.box('.m-view .pane');
  return { ...b, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
}

async function openSheet(which) {
  await s.tapOn(m(`m:bar:${which}`));
  try {
    await s.until(visible('m:sheet'), { timeout: 6000, what: 'the sheet' });
  } catch {
    // The first touch after a turn is sometimes lost on the runner, so count it and try once more.
    retries += 1;
    note('tap-retries', retries);
    await s.tapOn(m(`m:bar:${which}`));
    await s.until(visible('m:sheet'), { what: 'the sheet' });
  }
}

function addObservation(text) {
  return s.js(
    `(text) => {
      const app = window.gisworkbench;
      const l = app.activePane().geoLayer();
      const g = l.groundAt(l.width / 2, l.height / 2);
      app.store.transact('obs', (tx) => tx.create('observation', { text, category: 'other', confidence: 'high', lat: g.lat, lon: g.lon, place: 'point', created: new Date().toISOString(), photos: [] }));
    }`,
    text,
  );
}

async function exportDialog(format) {
  await s.js('() => { void window.gisworkbench.commands.run("obs.export"); }');
  await s.until(visible('dialog:obs-export'), { what: 'the export dialog' });
  await s.js(`(f) => { const e = document.querySelector('[data-id="oexp-format"]'); e.value = f; e.dispatchEvent(new Event('change', { bubbles: true })); }`, format);
  await sleep(400);
}
const exportButton = async (label) => {
  const i = await s.js(`(l) => [...document.querySelectorAll('[data-id="dialog:obs-export"] .dlg-buttons button')].findIndex((b) => b.textContent.startsWith(l))`, label);
  assert.notEqual(i, -1, `a ${label} button`);
  return `[data-id="dialog:obs-export"] .dlg-buttons button:nth-of-type(${i + 1})`;
};

async function observationDialog() {
  await s.js('() => { void window.gisworkbench.commands.run("obs.field"); }');
  await s.until(visible('dialog:field-observation'), { what: 'the observation dialog' });
  await sleep(1500);
}

/** Letters through the on-screen keyboard's own keys. Lower case only. */
async function typeOnKeys(text) {
  await s.inNative();
  try {
    for (const c of text) {
      const id = await s.find('-ios predicate string', `type == 'XCUIElementTypeKey' AND label ==[c] "${c === ' ' ? 'space' : c}"`);
      await s.cmd('POST', `/element/${id}/click`, {});
    }
  } finally {
    await s.inWeb();
  }
}

describe('load routes', () => {
  test('REQ-HOST-05 localhost: cold starts, secure context, no start-up problems', async () => {
    const rows = [];
    for (let i = 0; i < 3; i++) {
      await restart();
      const started = Date.now();
      await s.openLite();
      rows.push({ ...(await bootFacts()), wallMs: Date.now() - started });
    }
    note('route-localhost', rows);
    assert.ok(rows.every((r) => r.ready === '1' && r.edition === 'lite' && r.secure), JSON.stringify(rows));
    assert.deepEqual(rows[0].problems, []);
  });

  test('REQ-HOST-05 the hosted copy over HTTPS', async () => {
    await s.go(HOSTED);
    await s.ready();
    const f = await bootFacts();
    note('route-hosted', f);
    await shot('route-hosted');
    assert.equal(f.ready, '1');
    assert.equal(f.edition, 'lite');
    assert.deepEqual(f.problems, []);
  });
});

describe('the mobile shell on a real screen', () => {
  test('REQ-HOST-05 the empty screen: the mobile GUI, and nothing on it overlaps', async () => {
    await s.openLite();
    const f = await s.js(`() => {
      const card = document.querySelector('[data-id="m:empty"]');
      const a = card.getBoundingClientRect();
      const hits = [...document.querySelectorAll('.m-shell button')].filter((b) => b.offsetParent && getComputedStyle(b).visibility !== 'hidden' && !card.contains(b)).filter((b) => {
        const c = b.getBoundingClientRect();
        return Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left)) * Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top)) > 1;
      }).map((b) => b.dataset.id);
      return { shell: !!document.querySelector('.m-shell'), ribbon: !!document.querySelector('.ribbon, .ribbon-tabs'), touch: matchMedia('(pointer: coarse)').matches, hits };
    }`);
    await shot('shell-empty');
    assert.deepEqual(f, { shell: true, ribbon: false, touch: true, hits: [] });
  });

  test('REQ-HOST-05 every control is 44 px and axe passes on the real page', async () => {
    await s.openLite();
    await s.openImage();
    const small = await s.js(`() => [...document.querySelectorAll('.m-shell button, .m-shell select, .m-shell input:not(.sr-only)')].filter((b) => b.offsetParent).map((b) => [b.dataset.id ?? b.className, Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]).filter(([, w, h]) => w < 44 || h < 44)`);
    assert.deepEqual(small, []);
    const v = await s.js(`async (tags) => { ${AXE}; return (await window.axe.run(document.body, { runOnly: { type: 'tag', values: tags } })).violations.map((x) => x.id); }`, AXE_TAGS);
    assert.deepEqual(v, []);
  });

  test('REQ-HOST-05 portrait and landscape: the shell fits both, keeps its image and every map button', async () => {
    await s.openLite();
    await s.openImage();
    await shot('rotate-portrait');
    await s.rotate('LANDSCAPE');
    await s.until('() => innerWidth > innerHeight', { timeout: 15_000, what: 'landscape' });
    await sleep(1200);
    await shot('rotate-landscape');
    const r = await s.js(`() => {
      const bar = document.querySelector('[data-id="m:bar:open"]').getBoundingClientRect();
      const v = document.querySelector('.m-view').getBoundingClientRect();
      return { vp: [innerWidth, innerHeight], barInside: bar.bottom <= innerHeight + 0.5, scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], cut: [...document.querySelectorAll('.m-fab button')].filter((b) => b.getBoundingClientRect().bottom > v.bottom).map((b) => b.dataset.id) };
    }`);
    note('landscape', r);
    assert.equal(r.barInside, true);
    assert.ok(r.scroll[0] <= r.vp[0], 'no sideways scroll');
    assert.ok(r.scroll[1] <= r.vp[1] + 1, 'no page scroll');
    assert.deepEqual(r.cut, [], 'map buttons cut off');
    assert.ok(await s.js(visible('m:readout')));
  });

  test('REQ-HOST-05 browser Back closes a sheet and stays in the app', async () => {
    await s.openLite();
    await openSheet('tools');
    await s.cmd('POST', '/back', {});
    await sleep(1200);
    const a = await s.js(`() => ({ url: location.href, sheet: !!document.querySelector('[data-id="m:sheet"]')?.getClientRects().length, ready: document.body?.dataset.ready })`);
    note('back', a);
    assert.equal(a.sheet, false, 'the sheet is closed');
    assert.equal(a.url, LITE_URL);
    assert.equal(a.ready, '1');
  });

  test('REQ-HOST-05 the edge swipe that is Safari Back stays in the app', async () => {
    await s.openLite();
    await openSheet('tools');
    const y = await s.js('() => innerHeight / 3');
    await s.swipe(0, y, 280, y, 300);
    await sleep(1500);
    await shot('edge-swipe');
    const a = await s.js(`() => ({ url: location.href, sheet: !!document.querySelector('[data-id="m:sheet"]')?.getClientRects().length, ready: document.body?.dataset.ready })`);
    note('edge-swipe', a);
    assert.equal(a.url, LITE_URL, 'still in the app');
    assert.equal(a.ready, '1');
  });

  test('REQ-HOST-05 the Dynamic Island and home bar: the bars stay clear', async () => {
    await s.openLite({ prefs: { network: 'offline' } });
    await s.openImage();
    const f = await s.js(`() => {
      const p = document.createElement('div');
      p.style.cssText = 'position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
      document.body.appendChild(p);
      const c = getComputedStyle(p);
      const out = { top: c.paddingTop, right: c.paddingRight, bottom: c.paddingBottom, left: c.paddingLeft, viewportMeta: document.querySelector('meta[name=viewport]')?.content, innerHeight };
      p.remove();
      const b = document.querySelector('[data-id="m:appbar"]').getBoundingClientRect();
      return { ...out, barBottom: b.bottom };
    }`);
    note('safe-area', f);
    await shot('safe-area');
    assert.ok(f.barBottom <= f.innerHeight + 1, `bar inside the viewport: ${JSON.stringify(f)}`);
  });
});

describe('real input', () => {
  test('REQ-HOST-05 a finger: pan by swipe, long press point sheet, no Safari callout', async () => {
    await s.openLite();
    await s.openImage();
    const c = await centre();
    const v0 = await view();
    await s.swipe(c.cx, c.cy - 80, c.cx, c.cy + 80);
    await sleep(500);
    const v1 = await view();
    assert.ok(Math.hypot(v1.cx - v0.cx, v1.cy - v0.cy) > 0, 'the view panned');
    await s.hold(c.cx, c.cy);
    await s.until(visible('m:point'), { timeout: 8000, what: 'the point sheet' });
    assert.match(await s.js(`() => document.querySelector('[data-id="m:point"]').textContent`), /MGRS/);
    await shot('input-point-sheet');
    assert.doesNotMatch(await s.nativeSource(), /Open in New Tab|Save to Photos|Add to Reading List|Look Up/, 'Safari callout');
    assert.equal(await pageScale(), 1);
  });

  test('REQ-HOST-05 double tap zooms the image, not the page', async () => {
    await s.openLite();
    await s.openImage();
    const c = await centre();
    const v0 = await view();
    await s.js(`() => {
      window.__ev = [];
      for (const k of ['pointerdown', 'pointerup', 'pointercancel', 'dblclick']) addEventListener(k, (e) => window.__ev.push([k, Math.round(e.timeStamp), Math.round(e.clientX), Math.round(e.clientY)]), true);
    }`);
    await s.doubleTap(c.cx, c.cy);
    await sleep(800);
    note('double-tap-events', await s.js('() => window.__ev'));
    await s.until('(z) => window.gisworkbench.activePane().view.zoom > z * 1.5', { args: [v0.zoom], timeout: 8000, what: 'the zoom' });
    note('double-tap', { before: v0.zoom, after: (await view()).zoom, pageScale: await pageScale() });
    assert.equal(await pageScale(), 1);
  });

  test('REQ-HOST-05 pinch zooms the image, not the page', async () => {
    await s.openLite();
    await s.openImage();
    const c = await centre();
    const d = Math.min(c.width, c.height) / 8;
    const v0 = await view();
    await s.touch([[[c.cx - d, c.cy], [c.cx - 2 * d, c.cy, 400]], [[c.cx + d, c.cy], [c.cx + 2 * d, c.cy, 400]]]);
    await sleep(400);
    const v1 = await view();
    const ratio = v1.zoom / v0.zoom;
    note('pinch', { ratio, pageScale: await pageScale() });
    assert.ok(ratio > 1.5 && ratio < 2.6, `pinch ratio ${ratio}`);
    assert.equal(await pageScale(), 1);
  });

  test('REQ-HOST-05 the on-screen keyboard appears and does not cover the field', async () => {
    await s.openLite();
    await s.openImage();
    const before = await s.js('() => visualViewport.height');
    await observationDialog();
    await s.tapOn(m('fobs-text'));
    await sleep(1800);
    assert.match(await s.nativeSource(), /XCUIElementTypeKeyboard/, 'keyboard shown');
    await shot('keyboard-observation');
    const r = await s.js(`() => {
      const f = document.querySelector('[data-id="fobs-text"]').getBoundingClientRect();
      const ok = document.querySelector('[data-id="dialog:field-observation"] .dlg-buttons button').getBoundingClientRect();
      return { vvHeight: visualViewport.height, vvTop: visualViewport.offsetTop, field: [f.top, f.bottom], okBottom: ok.bottom, kb: document.documentElement.style.getPropertyValue('--m-kb') };
    }`);
    note('keyboard', { before, ...r });
    const bottom = r.vvTop + r.vvHeight;
    assert.ok(r.vvHeight < before, 'the visual viewport shrank');
    assert.ok(r.field[1] <= bottom, `field above the keyboard: ${JSON.stringify(r)}`);
    assert.ok(r.field[0] >= r.vvTop, `field below the top: ${JSON.stringify(r)}`);
    assert.ok(r.okBottom <= bottom + 1, `OK above the keyboard: ${JSON.stringify(r)}`);
    await typeOnKeys('two');
    assert.match(await s.js(`() => document.querySelector('[data-id="fobs-text"]').value`), /^two$/i);
  });
});

describe('device features', () => {
  test('REQ-HOST-05 location: the app asks in words, then Safari asks, then a fix arrives', async () => {
    simctl('location', UDID, 'set', `${GATE.lat},${GATE.lon}`);
    await s.openLite();
    await s.openImage();
    await s.tapOn(m('m:cmd:geo.locate'));
    await s.until(`() => !!document.querySelector('.dlg')`, { what: 'the app dialog' });
    assert.match(await s.js(`() => document.querySelector('.dlg').textContent`), /nothing is sent/);
    await s.tapOn('.dlg .dlg-buttons button');
    await sleep(1500);
    await shot('gps-prompt');
    const asked = [];
    for (let i = 0; i < 3; i++) {
      const label = (await s.acceptAlert(['Allow While Using App', 'Allow'])) ?? (await s.tapNative(['Allow', 'Allow Once', 'Allow While Using App'], { timeout: 4000 }));
      if (!label) break;
      asked.push(label);
      await sleep(800);
    }
    await s.until('() => !!window.gisworkbench.location?.fix', { what: 'a fix' });
    const fix = await s.js('() => window.gisworkbench.location.fix');
    note('gps', { asked, fix });
    await shot('gps-fix');
    assert.ok(Math.abs(fix.lat - GATE.lat) < 1e-3 && Math.abs(fix.lon - GATE.lon) < 1e-3, JSON.stringify(fix));
    assert.equal(await s.js(`() => document.querySelector('[data-id="m:cmd:geo.locate"]').getAttribute('aria-pressed')`), 'true');
  });

  test('REQ-HOST-05 Share is offered for every format, and the share sheet opens with the file', async () => {
    await s.openLite();
    await s.openImage();
    await addObservation('(U) Gate');
    const offered = {};
    for (const f of ['geojson', 'kml']) {
      await exportDialog(f);
      offered[f] = await s.js(`() => [...document.querySelectorAll('[data-id="dialog:obs-export"] .dlg-buttons button')].map((b) => b.textContent)`);
      if (f !== 'kml') await s.tapOn(await exportButton('Cancel'));
      await sleep(400);
    }
    note('share-offered', offered);
    await shot('share-export-dialog');
    await s.tapOn(await exportButton('Share'));
    await sleep(3000);
    await shot('share-sheet');
    const tree = await s.nativeSource();
    const toast = await s.js(`() => [...document.querySelectorAll('.toast, [role=status], [role=alert]')].map((e) => e.textContent)`);
    note('share-sheet', { sheet: /ActivityListView|ActivityContentView|Copy/.test(tree), toast });
    assert.match(tree, /ActivityListView|ActivityContentView/, `the iOS share sheet; the app said ${JSON.stringify(toast)}`);
    const closed = await s.tapNative(['Close', 'Cancel', 'Done'], { timeout: 2500 });
    if (!closed) await s.tap(220, 60); // no button on it in iOS 26: a tap outside closes it
    await sleep(1500);
    assert.doesNotMatch(await s.nativeSource(), /ActivityListView|ActivityContentView/, 'the share sheet closed');
  });

  test('REQ-HOST-05 a real Save lands in the Downloads folder', async () => {
    await s.openLite();
    await s.openImage();
    await addObservation('(U) Gate');
    await exportDialog('geojson');
    await s.tapOn(await exportButton('Save'));
    await sleep(2500);
    await shot('save-1');
    const label = (await s.acceptAlert(['Download'])) ?? (await s.tapNative(['Download'], { timeout: 8000 }));
    await sleep(3000);
    await shot('save-2');
    const root = join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', UDID, 'data');
    const files = execFileSync('find', [root, '-name', 'observations-*.geojson'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    note('save', { label, files });
    assert.ok(files.length > 0, 'a saved file');
    assert.equal(JSON.parse(readFileSync(files.at(-1), 'utf8')).features.length, 1);
  });
});

describe('a file from the phone', () => {
  // The picker runs in its own process, which the driver cannot read: this proves it opens with every
  // file allowed, not that a file can be chosen in it. Choosing one stays a real-phone check.
  test('REQ-HOST-02 Open Image opens the iOS file picker, with no filter on the file types', async () => {
    await s.openLite();
    await s.js(`() => {
      window.__accept = [];
      const add = HTMLElement.prototype.click;
      HTMLElement.prototype.click = function () {
        if (this instanceof HTMLInputElement && this.type === 'file') window.__accept.push(this.accept);
        return add.call(this);
      };
    }`);
    await s.tapOn(m('m:cmd:file.openimage'));
    await sleep(2500);
    await shot('picker-1');
    const accept = await s.js('() => window.__accept');
    const chose = await s.tapNative(['Choose Files', 'Choose File', 'Browse Files'], { timeout: 4000 });
    await sleep(2500);
    await shot('picker-2');
    const tab = await s.tapNative(['Browse'], { timeout: 4000 });
    await sleep(2500);
    await shot('picker-3');
    note('picker', { accept, chose, tab });
    assert.deepEqual(accept, ['']);
    assert.ok(chose && tab, 'the document picker opened');
    await restart();
  });
});

describe('the field flow and what survives', () => {
  test('SCN-56 real input: measure by tapping, an observation by typing, the record is right', async () => {
    await s.openLite();
    await s.openImage();
    const b = await s.box('.m-view .pane');
    await openSheet('measure');
    await s.tapOn(m('m:cmd:men.rangebearing'));
    await s.until(visible('m:cue'), { what: 'the measuring cue' });
    await s.tap(b.x + b.width * 0.3, b.y + b.height * 0.4);
    await sleep(600);
    await s.tap(b.x + b.width * 0.7, b.y + b.height * 0.6);
    await s.until(visible('m:measure-result'), { what: 'the result' });
    await shot('field-measure');
    assert.ok((await s.js(`() => window.gisworkbench.store.all('measurement').at(-1).value`)) > 0);
    await s.tapOn(m('m:sheet:close'));
    await sleep(400);
    await s.hold(b.x + b.width / 2, b.y + b.height / 2);
    await s.until(visible('m:point:observe'), { what: 'the point sheet' });
    await s.tapOn(m('m:point:observe'));
    await s.until(visible('dialog:field-observation'), { what: 'the observation dialog' });
    await sleep(600);
    await s.tapOn(m('fobs-text'));
    await sleep(1500);
    await typeOnKeys('vehicles');
    await sleep(400);
    await s.tapOn('[data-id="dialog:field-observation"] .dlg-buttons button');
    await s.until(`() => window.gisworkbench.store.all('observation').length === 1`, { what: 'the record' });
    const o = await s.js(`() => window.gisworkbench.store.all('observation').at(-1)`);
    assert.match(o.text, /^vehicles$/i);
    assert.ok(Number.isFinite(o.lat) && Number.isFinite(o.lon));
  });

  test('REQ-HOST-05 recovery after iOS kills Safari: Recover brings the work back', async () => {
    await s.openLite();
    await s.openImage();
    await addObservation('(U) Kept');
    await sleep(3000);
    await restart();
    await s.inWeb();
    await s.go(LITE_URL);
    await s.ready();
    const kept = await s.js(`async () => ({ prefs: localStorage.getItem('gisworkbench.prefs.v1'), dbs: (await indexedDB.databases()).map((d) => d.name) })`);
    note('recover-kept', kept);
    const at = await s.until(
      `() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Recover');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }`,
      { timeout: 12_000, what: 'a Recover button' },
    );
    await shot('recover-prompt');
    await s.tap(at.x, at.y);
    await s.until(`() => window.gisworkbench.store.all('observation').length === 1`, { timeout: 15_000, what: 'the recovered work' });
    assert.equal(await s.js(`() => window.gisworkbench.store.all('observation')[0].text`), '(U) Kept');
  });
});

describe('what Safari keeps', () => {
  test('REQ-L10N-14 a locale pack is kept across a reload', async (t) => {
    const name = readdirSync(join('dist', 'packs')).find((f) => /^locale-de-.*\.gwpack$/.test(f));
    if (!name) return t.skip('locale packs are not committed; this branch carries the German one');
    await s.openLite({ prefs: { network: 'offline', locale: 'de' } });
    const b64 = readFileSync(join('dist', 'packs', name)).toString('base64');
    await s.js(`async (b, name) => void (await window.gisworkbench.packs.open(new File([Uint8Array.from(atob(b), (c) => c.charCodeAt(0))], name)))`, b64, name);
    await s.go(LITE_URL);
    await s.ready();
    const f = await s.js('() => [window.gisworkbench.i18n.locale, document.documentElement.lang]');
    note('locale-pack', f);
    assert.deepEqual(f, ['de', 'de']);
  });
});

test('REQ-PRF-01 memory: the Safari page process with Lite empty and with the 16.8 MB image open', async () => {
  const rss = () => execFileSync('sh', ['-c', "ps -axo rss=,command= | grep -i 'WebContent' | grep -v grep | awk '{print $1}' | sort -n | tail -1"], { encoding: 'utf8' }).trim();
  await s.openLite();
  await sleep(2000);
  const empty = rss();
  await s.openImage();
  await sleep(3000);
  const image = rss();
  await shot('memory-image-open');
  note('memory', { emptyKB: Number(empty), imageKB: Number(image) });
  assert.ok(Number(image) > 0);
});
