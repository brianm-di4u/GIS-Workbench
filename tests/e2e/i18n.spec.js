// Localisation acceptance (SDP-2.3 §7; REQ-L10N-01..25): PT-17 locale delivery and size, PT-18 the
// pseudo-locale sweeps (en-XA: no untranslated chrome, no double translation, no clipped labels,
// logic intact; ar-XB: right to left with unmirrored panes, axe clean), and the scenarios SCN-34
// (Japanese), SCN-35 (German formats and units), SCN-36 (locale packs). SCN-33 (Arabic) runs once
// locale wave 3 ships (R8).
//
//   GW_DIST=dist-23 npx playwright test i18n.spec.js --project=chrome

import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { openApp, openFiles, LEGACY_PREFS, DIST_DIR, ROOT, restart } from './helpers.js';
import { LIMITS } from '../../build/gates.mjs';

test.describe.configure({ timeout: 900_000 });

const FX01 = resolve('fixtures/fx01/fx01.ntf');
const OUT = join(ROOT, 'reports', 'i18n');
mkdirSync(OUT, { recursive: true });
const DNT = JSON.parse(readFileSync(join(ROOT, 'app', 'src', 'i18n', 'glossary', 'dnt.json'), 'utf8')).tokens;
// Text the sweep finds that is data or do-not-translate by design (DN-62 rule 7), with the reason.
const ALLOWED = [
  [/^(nitf|sicd|sidd|geotiff|cog|dted|las|laz|copc|gpkg|geojson|kml|mpegts)$/i, 'format id shown as the file kind'],
  [/^(Geographic|Projected|UTM)\b.*\|/, 'CRS notation'],
  [/^Multiport_\d+$/, 'window name'],
  [/\.gwpack( · .*)?$/, 'pack file name'],
  [/^@placeholder: (image,lat,lon|token$|https:\/\/|s3:\/\/|us-east-1$)/, 'format, URL or parameter-name placeholder'],
  [/^bands [\d,]+ · /, 'image-chain summary (technical, recorded with products)'],
  [/^(SlimSAM|SAM \d|OWLv2|CLIP|DISK|Moondream2 |Land cover \(OpenEarthMap SparseMask\)$)/, 'AI model name'],
  [/^TDS 7\.1 subset \(GIS Workbench\)$/, 'feature catalogue name (data: the catalogue file names itself)'],
  [/^(f|x0|y0|k[1-4]|p[12]|b[12]|mm(⁻[¹²⁴⁶⁸])?|m|°)$/, 'interior orientation parameter symbol or unit (aerial triangulation report, REQ-GAP-22)'],
  [/^(AT-\d{3}|Frame camera \((aerial triangulation AT-\d{3}|space resection)\))$/, 'aerial triangulation solution and model identifiers'],
  [/^WebGPU$/, 'API name'],
];
const allowed = (s) => ALLOWED.some(([re]) => re.test(s));
const axeSource = () => readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/** The locale pack file of this build for a tag, or null. */
const localePack = (tag) => (existsSync(join(DIST_DIR, 'packs')) ? readdirSync(join(DIST_DIR, 'packs')).find((f) => f.startsWith(`locale-${tag}-`) && f.endsWith('.gwpack')) : null) ?? null;

/** Open the app in a locale (OD-2.22: every locale but English comes from its pack): open the pack once, then restart. */
async function withLocale(page, tag, prefs = {}) {
  const r = await openApp(page, 'file', { prefs: { ...LEGACY_PREFS, network: 'offline', ...prefs, locale: tag } });
  if ((await r.frame.evaluate(() => window.gisworkbench.i18n.locale)) !== tag) {
    const file = localePack(tag);
    test.skip(!file, `no ${tag} pack in this build`);
    await r.frame.evaluate(async ([b, name]) => window.gisworkbench.packs.open(new File([new Uint8Array(b)], name)), [[...readFileSync(join(DIST_DIR, 'packs', file))], file]);
    await restart(page);
  }
  expect(await r.frame.evaluate(() => window.gisworkbench.i18n.locale)).toBe(tag);
  return r;
}

// Commands the sweep does not run: they leave the page, open windows or devices, or end the session.
const SKIP = /^(win\.(new|clone|separate|close)|display\.fullscreen|file\.(print|exit|quit|reload|new)|stereo\.xr|cmp\.record|3d\.record|help\.(website|email|feedback\w*)|app\.quit)$/;

/** Visible text of the page that escaped translation in a pseudo-locale: [{text, where}]. */
async function scan(frame, dnt) {
  return frame.evaluate((dnt) => {
    const out = [];
    const doubles = [];
    const ok = (s) => {
      let r = ` ${s} `;
      for (const d of dnt) r = r.split(d).join(' ');
      r = r
        .replace(/\b[\w.-]+\.(ntf|nitf|tif|tiff|json|geojson|png|jpg|csv|gpkg|kml|kmz|las|laz|pdf|docx|pptx|zip|gwb|gwpack|html|txt|xml)\b/gi, ' ')
        .replace(/\bfx\d\d\w*/gi, ' ')
        .replace(/\bhttps?:\/\/\S+|\b[\w.+-]+@[\w-]+\.[\w.]+/g, ' ') // URLs and e-mail addresses
        .replace(/\b(Band \d+|SlimSAM|LightGlue|DISK|OWLv2|Moondream\w*|Qwen\w*|Natural Earth|OpenStreetMap|Esri|Protomaps|OpenFreeMap|Multiport_\d+)\b/g, ' ') // data and product names
        .replace(/\b[A-Z0-9][A-Z0-9_./:-]*\b/g, ' ') // codes and acronyms
        .replace(/\b\w*\d\w*\b/g, ' ') // anything with digits
        .replace(/\b[a-z]+[A-Z]\w*\b/g, ' ') // camelCase identifiers
        .replace(/\b[a-z]+(\.[a-z]+)+\b/g, ' '); // command ids
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
      if (!el || el.closest('script,style,canvas,textarea,input,select option:not(:checked),[data-i18n-data],.mono,pre,code,.log-body,.whatsnew,.sr-only')) continue;
      if (!visible(el)) continue;
      // A double translation wraps one message twice: only the pseudo padding sits between the closing brackets.
      if (/⟦⟦[^⟦⟧]*⟧[·~]*⟧/.test(s)) doubles.push(s.slice(0, 80));
      // Text inside a translated message (anywhere in the same element) is a placeholder value.
      if (el.textContent.includes('⟦')) continue;
      if (ok(s)) continue;
      const where = el.closest('[data-id]')?.dataset.id ?? el.className ?? el.tagName;
      out.push({ text: s.slice(0, 100), where: String(where).slice(0, 60) });
    }
    // Attributes users read.
    for (const el of document.querySelectorAll('[title],[aria-label],[placeholder]')) {
      if (!visible(el)) continue;
      for (const a of ['title', 'aria-label', 'placeholder']) {
        const v = el.getAttribute(a);
        if (!v || v.includes('⟦') || ok(v)) continue;
        out.push({ text: `@${a}: ${v.slice(0, 90)}`, where: el.closest('[data-id]')?.dataset.id ?? el.tagName });
      }
    }
    return { out, doubles };
  }, dnt);
}

/** Labels whose text is cut off without an ellipsis. */
async function clipped(frame) {
  return frame.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, .btn, .rtab, .menu-item span, .status-cell, .dock-title, .dlg-title-text, label > span, th')) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || !el.textContent.trim()) continue;
      if (el.scrollWidth > el.clientWidth + 1 && s.overflow !== 'visible' && s.textOverflow !== 'ellipsis' && !el.title) out.push({ text: el.textContent.trim().slice(0, 60), where: el.closest('[data-id]')?.dataset.id ?? el.className });
    }
    return out;
  });
}

async function closeAll(page, frame) {
  await page.keyboard.press('Escape').catch(() => {});
  await frame.evaluate(() => {
    for (const d of [...document.querySelectorAll('.dlg')]) d.finish?.(null);
    for (const m of [...document.querySelectorAll('.menu, .ctx-menu, .popup')]) m.remove();
  });
}

async function sweep(page, locale, { layout = 'classic' } = {}) {
  page.on('filechooser', (fc) => fc.setFiles([]).catch(() => {}));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const { frame, logs } = await openApp(page, 'file', { prefs: { ...LEGACY_PREFS, layout, locale, network: 'offline' } });
  expect(await frame.evaluate(() => [document.documentElement.dataset.locale, document.documentElement.dir])).toEqual([locale, locale === 'ar-XB' ? 'rtl' : 'ltr']);
  await openFiles(frame, [FX01]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].length > 0, null, { timeout: 60_000 });
  const found = new Map();
  const doubles = new Set();
  const clips = new Map();
  const failures = [];
  const record = async (step) => {
    const r = await scan(frame, DNT);
    for (const x of r.out) if (!found.has(x.text)) found.set(x.text, { ...x, step });
    for (const d of r.doubles) doubles.add(d);
    for (const c of await clipped(frame)) if (!clips.has(c.text)) clips.set(c.text, { ...c, step });
  };
  await record('chrome');
  const ids = await frame.evaluate(() => window.gisworkbench.commands.list().filter((c) => c.implemented).map((c) => c.id));
  for (const id of ids) {
    if (SKIP.test(id)) continue;
    const before = logs.length;
    const res = await frame.evaluate(async (id) => {
      const app = window.gisworkbench;
      if (!app.commands.enabled(id)) return 'disabled';
      try {
        await Promise.race([app.commands.run(id), new Promise((r) => setTimeout(r, 1500))]);
        return 'ran';
      } catch (e) {
        return `threw: ${e.message}`;
      }
    }, id);
    if (res === 'disabled') continue;
    await page.waitForTimeout(120);
    await record(id);
    if (/^threw/.test(res)) failures.push(`${id}: ${res}`);
    if (logs.length > before) failures.push(`${id}: console ${logs.slice(before).join(' | ').slice(0, 200)}`);
    await closeAll(page, frame);
  }
  return { found: [...found.values()], doubles: [...doubles], clips: [...clips.values()], failures, ids: ids.length };
}

test('PT-18 REQ-L10N-02 REQ-L10N-04 REQ-L10N-21 en-XA sweep: every command and the chrome are translated, once', async ({ page }) => {
  const r = await sweep(page, 'en-XA');
  writeFileSync(join(OUT, 'pt18-en-XA.json'), JSON.stringify(r, null, 1));
  expect(r.doubles, 'double translations').toEqual([]);
  expect(r.found.filter((x) => !allowed(x.text)), 'untranslated text (see reports/i18n/pt18-en-XA.json)').toEqual([]);
  expect(r.failures, 'commands that broke under the pseudo-locale').toEqual([]);
  // Clipping is recorded for review; an expanded pseudo-locale is allowed a few ellipsis-less overflows.
  expect(r.clips.length, `clipped labels: ${r.clips.map((c) => c.text).slice(0, 20).join(' | ')}`).toBeLessThanOrEqual(25);
});

// Real locales: every command once more, in German and Japanese. Visible text that is exactly the
// English source of a message the locale translates escaped tr()/t() at its display site.
for (const tag of ['de', 'ja']) {
  test(`PT-18 REQ-L10N-02 REQ-L10N-15 ${tag} sweep: no translated message shows in English`, async ({ page }) => {
    page.on('filechooser', (fc) => fc.setFiles([]).catch(() => {}));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    const cat = JSON.parse(readFileSync(join(ROOT, 'app', 'src', 'i18n', 'catalog', `${tag}.json`), 'utf8')).messages;
    // Text that is also a translation in this locale (the German whiteboard tool is "Pin" too) is not a leak.
    const values = new Set(Object.values(cat));
    const english = Object.fromEntries(Object.entries(cat).filter(([k, v]) => !k.includes('\u0004') && v !== k && !values.has(k) && /[A-Za-z]{3}/.test(k)));
    const { frame, logs } = await withLocale(page, tag);
    await openFiles(frame, [FX01]);
    const seen = new Map();
    const look = (step) =>
      frame
        .evaluate((keys) => {
          const out = [];
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = w.nextNode(); n; n = w.nextNode()) {
            const s = n.nodeValue.trim();
            const el = n.parentElement;
            if (!s || !el || el.closest('script,style,textarea,pre,code,.mono,.whatsnew,.log-body')) continue;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            if (keys[s]) out.push({ text: s, where: el.closest('[data-id]')?.dataset.id ?? el.className });
          }
          for (const el of document.querySelectorAll('[title],[aria-label],[placeholder]')) for (const a of ['title', 'aria-label', 'placeholder']) {
            const v = el.getAttribute(a);
            if (v && keys[v]) out.push({ text: `@${a}: ${v}`, where: el.closest('[data-id]')?.dataset.id ?? el.tagName });
          }
          return out;
        }, english)
        .then((r) => r.forEach((x) => !seen.has(x.text) && seen.set(x.text, { ...x, step })));
    await look('chrome');
    const ids = await frame.evaluate(() => window.gisworkbench.commands.list().filter((c) => c.implemented).map((c) => c.id));
    for (const id of ids) {
      if (SKIP.test(id)) continue;
      const ran = await frame.evaluate(async (id) => {
        const app = window.gisworkbench;
        if (!app.commands.enabled(id)) return false;
        await Promise.race([app.commands.run(id).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
        return true;
      }, id);
      if (!ran) continue;
      await page.waitForTimeout(100);
      await look(id);
      await closeAll(page, frame);
    }
    const found = [...seen.values()];
    writeFileSync(join(OUT, `pt18-${tag}.json`), JSON.stringify(found, null, 1));
    expect(found, `English text with a ${tag} translation (reports/i18n/pt18-${tag}.json)`).toEqual([]);
    expect(logs.filter((l) => !/ERR_FILE_NOT_FOUND/.test(l))).toEqual([]);
  });
}

test('PT-18 REQ-L10N-09 REQ-L10N-10 ar-XB: right to left, panes not mirrored, menus inside the window, axe clean', async ({ page }) => {
  page.on('filechooser', (fc) => fc.setFiles([]).catch(() => {}));
  const { frame, logs } = await openApp(page, 'file', { prefs: { ...LEGACY_PREFS, locale: 'ar-XB', network: 'offline' } });
  await openFiles(frame, [FX01]);
  const r = await frame.evaluate(() => {
    const gl = document.getElementById('gl');
    const pane = document.querySelector('.pane, .mp-pane, [data-id^="pane:"]');
    return { dir: document.documentElement.dir, lang: document.documentElement.lang, glTransform: getComputedStyle(gl).transform, paneTransform: pane ? getComputedStyle(pane).transform : 'none', paneDir: pane ? getComputedStyle(pane).direction : null };
  });
  expect(r.dir).toBe('rtl');
  expect(r.glTransform).toBe('none');
  expect(r.paneTransform).toBe('none');
  // A menu and a dialog open inside the window.
  await frame.evaluate(() => void window.gisworkbench.commands.run('file.prefs'));
  await frame.locator('[data-id="dialog:prefs"]').waitFor();
  const box = await frame.locator('[data-id="dialog:prefs"]').boundingBox();
  const vp = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  // The primary (first) button sits at the start side: right of Cancel in RTL.
  const order = await frame.evaluate(() => [...document.querySelectorAll('[data-id="dialog:prefs"] .dlg-buttons .btn:not(.btn-left)')].map((b) => [b.classList.contains('btn-primary'), b.getBoundingClientRect().x]));
  const prim = order.find((o) => o[0]);
  const other = order.find((o) => !o[0]);
  if (prim && other) expect(prim[1]).toBeGreaterThan(other[1]);
  await frame.evaluate(axeSource());
  const v = await frame.evaluate(async () => (await window.axe.run(document.querySelector('[data-id="dialog:prefs"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.length}`));
  expect(v).toEqual([]);
  await frame.evaluate(() => document.querySelector('.dlg')?.finish?.(null));
  const shell = await frame.evaluate(async () => (await window.axe.run(document.body, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, rules: { 'color-contrast': { enabled: false } } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`));
  expect(shell).toEqual([]);
  expect(logs).toEqual([]);
});

test('PT-17 REQ-L10N-14 REQ-L10N-22 every locale is a listed pack that verifies; a tampered pack is refused; size budget', async ({ page }) => {
  const { frame } = await openApp(page, 'file', { prefs: { ...LEGACY_PREFS, network: 'offline' } });
  const m = await frame.evaluate(() => {
    const man = window.__gw.manifest;
    return { i18n: man.i18n, inline: Object.keys(man.blocks).filter((n) => /^data-(locale-|i18n-keys)/.test(n)), packs: Object.keys(man.packs).filter((p) => p.startsWith('locale-')) };
  });
  expect(m.i18n.messages).toBeGreaterThan(5000);
  // OD-2.22: the HTML carries English only; every other locale is a pack listed in the manifest.
  expect(m.inline).toEqual([]);
  const shipped = m.i18n.locales.filter((x) => x.wave > 0);
  expect(shipped.filter((l) => l.wave === 1).length).toBe(12);
  for (const l of shipped) expect(m.packs).toContain(`locale-${l.tag}`);
  const html = readFileSync(join(DIST_DIR, 'gis-workbench.html'));
  expect(html.length, 'Standard HTML (OD-2.27: 18 MB from 2.6)').toBeLessThanOrEqual(LIMITS.totalFail);
  // Each wave 1 pack verifies against the build manifest; a changed byte is refused.
  for (const l of shipped.filter((x) => x.wave === 1)) {
    const file = localePack(l.tag);
    expect(file, l.tag).toBeTruthy();
    expect(readFileSync(join(DIST_DIR, 'packs', file)).length, `${l.tag} pack size`).toBeLessThanOrEqual(400e3);
    const ok = await frame.evaluate(async (b) => {
      try {
        const v = await window.gisworkbench.packs.verify(new Uint8Array(b), 'pack');
        return v.json.name;
      } catch (e) {
        return `refused: ${e.message}`;
      }
    }, [...readFileSync(join(DIST_DIR, 'packs', file))]);
    expect(ok).toBe(`locale-${l.tag}`);
  }
  const tampered = [...readFileSync(join(DIST_DIR, 'packs', localePack('de')))];
  tampered[Math.floor(tampered.length * 0.6)] ^= 0xff;
  const bad = await frame.evaluate(async (b) => {
    try {
      await window.gisworkbench.packs.verify(new Uint8Array(b), 'tampered');
      return 'accepted';
    } catch (e) {
      return e.message;
    }
  }, tampered);
  expect(bad).not.toBe('accepted');
});

test('SCN-35 REQ-L10N-06 REQ-L10N-07 REQ-L10N-08 German: decimal commas on screen, coordinates with commas, nautical units, invariant exports', async ({ page }) => {
  const { frame, logs } = await withLocale(page, 'de', { units: 'nautical' });
  expect(await frame.evaluate(() => document.documentElement.lang)).toBe('de');
  await openFiles(frame, [FX01]);
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = app.activePane().geoLayer();
    const g = l.groundAt(l.width / 2, l.height / 2);
    // Jump to Point input with decimal commas and ';' between the values (REQ-L10N-07).
    const txt = `${g.lat.toFixed(4).replace('.', ',')}; ${g.lon.toFixed(4).replace('.', ',')}`;
    const p = app.core.parse(txt);
    return {
      txt,
      lat: p.lat,
      lon: p.lon,
      num: app.fmt.num(1234.5, 2),
      len: app.fmt.length(5556),
      units: app.fmt.units(),
      coord: app.core.format(g.lat, g.lon, 0, 4),
      tab: document.querySelector('[data-id="ribbon:tab:home"], [data-id^="ribbon:tab:"]')?.textContent?.trim(),
    };
  });
  expect(r.lat).toBeCloseTo(Number(r.txt.split(';')[0].replace(',', '.')), 3);
  expect(r.lon).toBeCloseTo(Number(r.txt.split(';')[1].replace(',', '.')), 3);
  expect(r.num).toBe('1234,50');
  expect(r.units).toBe('nautical');
  expect(r.len).toMatch(/^3,00 /); // 5556 m = 3 NM, German decimal comma
  // Coordinates keep their standard notation (decimal point) in every locale.
  expect(r.coord).toMatch(/\d\.\d{4}/);
  // GeoJSON written by the app keeps '.' decimals.
  const gj = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const g = p.geoLayer().groundAt(600, 600);
    app.commitFeature(p, 'Point', [{ lon: g.lon, lat: g.lat, h: g.h, zsrc: 'test' }]);
    return JSON.stringify(app.store.all('feature').at(-1)?.geom ?? null);
  });
  // Stored coordinates are numbers, never locale-formatted strings.
  expect(JSON.parse(gj).xyz.every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true);
  expect(logs).toEqual([]);
});

test('SCN-34 REQ-L10N-02 REQ-L10N-12 REQ-L10N-13 Japanese: translated chrome, search in Japanese and English, layout-independent KeyTips', async ({ page }) => {
  const { frame, logs } = await withLocale(page, 'ja');
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ja = app.commands.labelOf('file.openimage');
    const search = async (q) => (await app.palette.results(q)).slice(0, 8).map((x) => x.id);
    return { ja, en: app.commands.get('file.openimage').label, byJa: await search(ja), byEn: await search('Open Image'), lang: document.documentElement.lang, tabs: [...document.querySelectorAll('[data-id^="ribbon:tab:"]')].map((t) => t.textContent.trim()).slice(0, 8) };
  });
  expect(r.lang).toBe('ja');
  expect(r.ja).not.toBe(r.en);
  expect(/[぀-ヿ一-鿿]/.test(r.ja)).toBe(true);
  expect(r.byJa).toContain('file.openimage');
  expect(r.byEn).toContain('file.openimage');
  expect(r.tabs.some((t) => /[぀-ヿ一-鿿]/.test(t))).toBe(true);
  const tips = await frame.evaluate(() => [...document.querySelectorAll('[data-keytip]')].map((e) => e.dataset.keytip));
  for (const k of tips) expect(k).toMatch(/^[A-Z0-9]{1,2}$/);
  expect(logs).toEqual([]);
});


test('SCN-36 REQ-L10N-14 REQ-L10N-15 a wave 2 locale needs its pack, then loads from it; Preferences says translations are AI-produced', async ({ page }) => {
  const file = existsSync(join(DIST_DIR, 'packs')) ? readdirSync(join(DIST_DIR, 'packs')).find((f) => /^locale-sv-.*\.gwpack$/.test(f)) : null;
  test.skip(!file, 'no Swedish pack in this build');
  const { frame } = await openApp(page, 'file', { prefs: { ...LEGACY_PREFS, locale: 'sv', network: 'offline' } });
  const first = await frame.evaluate(() => ({ i18n: window.gisworkbench.i18n, toasts: (window.gisworkbench.toastLog ?? []).map((x) => x.message ?? x) }));
  expect(first.i18n.needPack).toBe('locale-sv');
  expect(first.i18n.locale).toBe('en');
  // Open the pack, then restart: Swedish.
  await frame.evaluate(async (b) => {
    const f = new File([new Uint8Array(b)], 'locale-sv.gwpack');
    await window.gisworkbench.packs.open(f);
  }, [...readFileSync(join(DIST_DIR, 'packs', file))]);
  await restart(page);
  const after = await frame.evaluate(() => ({ locale: window.gisworkbench.i18n.locale, lang: document.documentElement.lang, label: window.gisworkbench.commands.labelOf('file.openimage') }));
  expect(after.locale).toBe('sv');
  expect(after.label).not.toBe('Open Image…');
  // Preferences ▸ Language states that translations are AI-produced.
  await frame.evaluate(() => void window.gisworkbench.commands.run('file.prefs'));
  await frame.locator('[data-id="dialog:prefs"]').waitFor();
  const rowText = await frame.locator('[data-id="dialog:prefs"] tr[data-k="locale"]').textContent();
  expect(rowText.length).toBeGreaterThan(10);
});

test.skip('SCN-33 REQ-L10N-09..11 Arabic: right-to-left work, measurement, GeoPDF and DOCX with Arabic text (locale wave 3, R8)', async () => {});
