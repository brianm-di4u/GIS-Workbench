// Pseudo-locale smoke (DN-62 "Checking your work"; SDP-2.3 §7): opens the built app in en-XA with
// FX-01, walks the chrome a user reads — Ribbon tabs and split menus, the File menu, the Modern
// menu bar and its submenus, context menus, docks, the status bar, the Command Palette,
// Preferences (every category), the Keyboard Map, Help Topics, Accuracy and Limits, About, the
// Mensuration Log with a measurement — and lists every visible text that escaped t() (no ⟦…⟧) and
// every double translation (⟦⟦). The command-by-command sweep is PT-18 in i18n.spec.js; this
// script covers the surfaces a command run does not open, and runs in about a minute.
//
//   node tests/e2e/i18n-smoke.mjs [dist-folder] [--locale en-XA] [--json reports/i18n/smoke.json]
//
// Exit code 1 when anything is found. Data (file names, coordinates, DN-62 rule-7 terms from
// app/src/i18n/glossary/dnt.json) is not reported.

import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const distArg = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? process.env.GW_DIST ?? 'dist';
const DIST = distArg.endsWith('.html') ? resolve(distArg) : join(resolve(distArg), 'gis-workbench.html');
const LOCALE = opt('--locale', 'en-XA');
const OUT = opt('--json', join('reports', 'i18n', `smoke-${LOCALE}.json`));
const FX01 = resolve('fixtures/fx01/fx01.ntf');
const DNT = JSON.parse(readFileSync(resolve('app/src/i18n/glossary/dnt.json'), 'utf8')).tokens;
const PREFS = { layout: 'classic', network: 'offline', locale: LOCALE };

/** Untranslated visible text and double translations on the page now (as PT-18 scans). */
function scanPage(dnt) {
  const out = [];
  const doubles = [];
  const ok = (s) => {
    let r = ` ${s} `;
    for (const d of dnt) r = r.split(d).join(' ');
    r = r
      .replace(/\b[\w.-]+\.(ntf|nitf|tif|tiff|json|geojson|png|jpg|csv|gpkg|kml|kmz|las|laz|pdf|docx|pptx|zip|gwb|gwpack|html|txt|xml)\b/gi, ' ')
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
  // A translated text translated again: the inner message is followed only by the outer
  // pad (⟦⟦Çļóšé·~⟧·~~~⟧). "⟦⟦Ļáýéŕš⟧ þóšíţíóñ⟧" is a message whose first placeholder holds a
  // translated value, which is correct.
  const twice = (s) => /⟦⟦[^⟦⟧]*⟧[·~]*⟧/.test(s);
  const where = (el) => String(el.closest('[data-id]')?.dataset.id ?? el.className ?? el.tagName).slice(0, 60);
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const s = n.nodeValue.trim();
    if (!s) continue;
    const el = n.parentElement;
    if (!el || el.closest('script,style,canvas,textarea,input,select option:not(:checked),[data-i18n-data],.mono,pre,code,.log-body,.whatsnew,.sr-only')) continue;
    if (!visible(el)) continue;
    if (twice(s)) doubles.push({ text: s.slice(0, 100), where: where(el) });
    if (el.textContent.includes('⟦')) continue;
    if (!ok(s)) out.push({ text: s.slice(0, 100), where: where(el) });
  }
  for (const el of document.querySelectorAll('[title],[aria-label],[placeholder]')) {
    if (!visible(el)) continue;
    for (const a of ['title', 'aria-label', 'placeholder']) {
      const v = el.getAttribute(a);
      if (!v) continue;
      if (twice(v)) doubles.push({ text: `@${a}: ${v.slice(0, 90)}`, where: where(el) });
      if (v.includes('⟦') || ok(v)) continue;
      out.push({ text: `@${a}: ${v.slice(0, 90)}`, where: where(el) });
    }
  }
  return { out, doubles };
}

const found = new Map();
const doubles = new Map();
const errors = [];

async function open(browser, layout) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(`${layout}: ${e.message}`));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  page.on('filechooser', (fc) => fc.setFiles([]).catch(() => {}));
  await page.addInitScript((p) => {
    try {
      localStorage.setItem('gisworkbench.prefs.v1', JSON.stringify(p));
    } catch {
      /* storage blocked */
    }
  }, { ...PREFS, layout });
  await page.goto(pathToFileURL(DIST).href);
  await page.waitForFunction(() => document.body?.dataset.ready === '1', null, { timeout: 60_000 });
  const input = await page.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.style.display = 'none';
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles([FX01]);
  await page.evaluate(async (i) => {
    const files = [...i.files];
    i.remove();
    await window.gisworkbench.openFiles(files);
  }, input);
  await page.waitForFunction(() => window.gisworkbench.layers.size > 0, null, { timeout: 60_000 });
  await page.waitForTimeout(500);
  return page;
}

async function record(page, step) {
  const r = await page.evaluate(scanPage, DNT);
  for (const x of r.out) if (!found.has(x.text)) found.set(x.text, { ...x, step });
  for (const x of r.doubles) if (!doubles.has(x.text)) doubles.set(x.text, { ...x, step });
}

async function closeAll(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    for (const d of [...document.querySelectorAll('.dlg')]) d.finish?.(null);
    for (const m of [...document.querySelectorAll('.menu, .ctx-menu, .popup')]) m.remove();
  });
}

const run = (page, id, arg) => page.evaluate(([id, arg]) => Promise.race([window.gisworkbench.commands.run(id, arg), new Promise((r) => setTimeout(r, 1500))]), [id, arg]);

async function dialogs(page, layout) {
  for (const id of ['help.keys', 'help.limits', 'help.about', 'help.topics']) {
    await run(page, id);
    await page.waitForTimeout(250);
    if (id === 'help.topics') await page.evaluate(() => document.querySelectorAll('.dlg details').forEach((d) => (d.open = true)));
    await record(page, `${layout}: ${id}`);
    await closeAll(page);
  }
  // Preferences: every category.
  await run(page, 'file.prefs');
  await page.waitForTimeout(300);
  // Each category of the tree, in each scope tab (User, Computer…).
  const tabsN = Math.max(1, await page.locator('.dlg .prefs-tabs [role="tab"]').count());
  for (let k = 0; k < tabsN; k++) {
    await page.locator('.dlg .prefs-tabs [role="tab"]').nth(k).click().catch(() => {});
    const cats = await page.locator('.dlg .prefs-tree [role="treeitem"]').count();
    for (let i = 0; i < cats; i++) {
      await page.locator('.dlg .prefs-tree [role="treeitem"]').nth(i).click().catch(() => {});
      await page.waitForTimeout(120);
      await record(page, `${layout}: prefs tab ${k} category ${i}`);
    }
  }
  await closeAll(page);
  // The Command Palette, empty and with a query.
  await run(page, 'ui.palette');
  await page.waitForTimeout(250);
  await record(page, `${layout}: palette`);
  await page.keyboard.type('mea');
  await page.waitForTimeout(250);
  await record(page, `${layout}: palette query`);
  await closeAll(page);
}

async function docks(page, layout) {
  // A point measurement in the Mensuration Log (FX-01 has a sensor model).
  await page.evaluate(() => window.gisworkbench.tools.select('men.point'));
  const box = await page.locator('canvas#gl, .pane canvas, [data-id^="pane:"]').first().boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  await page.evaluate(() => window.gisworkbench.tools.select(null));
  for (const id of ['dock.layers', 'dock.toolbox', 'dock.cues', 'dock.menlog', 'dock.jobs', 'dock.netlog', 'dock.importlog']) {
    const ok = await page.evaluate((id) => !!window.gisworkbench.commands.get(id)?.implemented, id);
    if (!ok) continue;
    await run(page, id);
    await page.waitForTimeout(250);
    await record(page, `${layout}: ${id}`);
  }
  // Context menus: the panel and the status bar.
  if (box) {
    await page.mouse.click(box.x + box.width / 3, box.y + box.height / 3, { button: 'right' });
    await page.waitForTimeout(250);
    await record(page, `${layout}: panel context menu`);
    await closeAll(page);
  }
  const sb = page.locator('.statusbar').first();
  if (await sb.count()) {
    await sb.click({ button: 'right' }).catch(() => {});
    await page.waitForTimeout(200);
    await record(page, `${layout}: status bar menu`);
    await closeAll(page);
  }
}

async function ribbon(page) {
  const tabs = await page.locator('[data-id^="ribbon:tab:"]').evaluateAll((els) => els.map((e) => e.dataset.id));
  for (const id of tabs) {
    await page.locator(`[data-id="${id}"]`).first().click().catch(() => {});
    await page.waitForTimeout(150);
    await record(page, `ribbon ${id}`);
    const carets = await page.locator('.rsplit-caret:visible').count();
    for (let i = 0; i < carets; i++) {
      await page.locator('.rsplit-caret:visible').nth(i).click().catch(() => {});
      await page.waitForTimeout(100);
      await record(page, `ribbon ${id} split ${i}`);
      await page.keyboard.press('Escape');
    }
  }
  await page.locator('[data-id="ribbon:file"]').first().click().catch(() => {});
  await page.waitForTimeout(200);
  await record(page, 'ribbon file menu');
  await closeAll(page);
}

async function menubar(page) {
  const items = await page.locator('.menubar-item').count();
  for (let i = 0; i < items; i++) {
    await page.locator('.menubar-item').nth(i).click().catch(() => {});
    await page.waitForTimeout(150);
    await record(page, `menu ${await page.locator('.menubar-item').nth(i).getAttribute('data-id')}`);
    const subs = await page.locator('.menu [aria-haspopup="menu"]:visible').count();
    for (let k = 0; k < Math.min(subs, 20); k++) {
      await page.locator('.menu [aria-haspopup="menu"]:visible').nth(k).hover().catch(() => {});
      await page.waitForTimeout(120);
      await record(page, `menu ${i} submenu ${k}`);
    }
    await closeAll(page);
  }
}

const browser = await chromium.launch({ channel: process.platform === 'linux' ? undefined : 'chrome', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
try {
  if (!existsSync(DIST)) throw new Error(`no build at ${DIST}`);
  const classic = await open(browser, 'classic');
  await record(classic, 'classic: chrome');
  await ribbon(classic);
  await menubar(classic);
  await docks(classic, 'classic');
  await dialogs(classic, 'classic');
  await classic.close();
  const modern = await open(browser, 'modern');
  await record(modern, 'modern: chrome');
  await ribbon(modern);
  await menubar(modern);
  await docks(modern, 'modern');
  await dialogs(modern, 'modern');
  await modern.close();
} finally {
  await browser.close();
}

const result = { locale: LOCALE, dist: DIST, untranslated: [...found.values()], doubles: [...doubles.values()], errors };
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 1));
for (const [k, list] of [['untranslated', result.untranslated], ['double translations', result.doubles], ['page errors', errors.map((e) => ({ text: e }))]]) {
  console.log(`${k}: ${list.length}`);
  for (const x of list) console.log(`  ${x.text}${x.where ? `   [${x.where}; ${x.step}]` : ''}`);
}
console.log(`written ${OUT}`);
process.exitCode = result.untranslated.length || result.doubles.length || errors.length ? 1 : 0;
