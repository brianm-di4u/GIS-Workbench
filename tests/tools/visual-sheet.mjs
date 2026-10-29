// GUI3 campaign: contact sheets of the visual audit's screenshots. One row per surface, one
// column per layout × theme, optionally a "before" row above the "after" row, so a surface can be
// judged across every theme at a glance. Writes reports/gui3/sheet-<build>.html and, with --png,
// renders selected surfaces to reports/gui3/strips/<surface>.png for review and the report.
//   node tests/tools/visual-sheet.mjs --after after-full [--before before-full] [--build full]
//        [--png "menu:main-menu,dock:layers"]
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const BASE = resolve('reports', 'gui3');
const AFTER = arg('after');
const BEFORE = arg('before', null);
const BUILD = arg('build', 'full');
const load = (label) => (label && existsSync(join(BASE, label, 'audit.json')) ? JSON.parse(readFileSync(join(BASE, label, 'audit.json'), 'utf8')) : null);
const a = load(AFTER);
const b = load(BEFORE);
if (!a) throw new Error(`no audit for ${AFTER}`);
const combos = a.meta.combos;
const index = (audit, label) => {
  const m = new Map();
  for (const r of audit?.results ?? []) if (r.shot && r.build === BUILD) m.set(`${r.surface}|${r.combo}`, { src: relative(BASE, join(BASE, label, r.shot)).replace(/\\/g, '/'), n: (r.findings ?? []).filter((f) => f.kind !== 'axe').length });
  return m;
};
const ia = index(a, AFTER);
const ib = index(b, BEFORE);
const surfaces = [...new Set(a.results.filter((r) => r.shot && r.build === BUILD).map((r) => r.surface))].sort();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const cell = (m, s, c) => {
  const v = m.get(`${s}|${c}`);
  return v ? `<td><a href="${esc(v.src)}"><img loading="lazy" src="${esc(v.src)}" alt=""></a><span class="${v.n ? 'bad' : 'ok'}">${v.n}</span></td>` : '<td class="none">–</td>';
};
const row = (s) => `<tr id="${esc(s)}"><th>${esc(s)}${b ? '<br><small>before / after</small>' : ''}</th>${combos.map((c) => `<td class="pair">${b ? `<table><tr>${cell(ib, s, c)}</tr><tr>${cell(ia, s, c)}</tr></table>` : `<table><tr>${cell(ia, s, c)}</tr></table>`}</td>`).join('')}</tr>`;
const html = `<!doctype html><meta charset="utf-8"><title>GUI3 contact sheet ${esc(BUILD)}</title>
<style>body{font:12px system-ui;margin:8px;background:#fff;color:#111}table{border-collapse:collapse}th{position:sticky;left:0;background:#f4f4f4;text-align:left;vertical-align:top;padding:4px;max-width:180px;word-break:break-all}
thead th{position:sticky;top:0;z-index:2}td{padding:2px;vertical-align:top}td.pair{border-left:1px solid #ccc}img{max-width:150px;max-height:110px;display:block;border:1px solid #999}
span{font-size:10px;padding:0 3px;border-radius:3px}.bad{background:#b3261e;color:#fff}.ok{background:#2e7d32;color:#fff}.none{color:#999}</style>
<h1>GUI3 contact sheet — ${esc(BUILD)} — ${esc(AFTER)}${b ? ` vs ${esc(BEFORE)}` : ''}</h1><p>Badge: findings on that surface (axe duplicates excluded). Click a picture for full size.</p>
<table><thead><tr><th>surface</th>${combos.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${surfaces.map(row).join('\n')}</tbody></table>`;
const out = join(BASE, `sheet-${BUILD}.html`);
writeFileSync(out, html);
console.log(`${surfaces.length} surfaces × ${combos.length} combos → ${out}`);

// Grid: every surface of one combo, 20 to an image (for a by-eye pass over layout defects).
const grid = arg('grid', '');
if (grid) {
  mkdirSync(join(BASE, 'strips'), { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1900, height: 1000 } });
  const list = surfaces.filter((s) => ia.has(`${s}|${grid}`) && (!arg('only') || s.startsWith(arg('only'))));
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20);
    const one = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:12px system-ui;background:#fff;display:grid;grid-template-columns:repeat(5,376px);gap:4px}figure{margin:0}img{max-width:376px;max-height:300px;display:block;border:1px solid #888}figcaption{font-weight:600}</style>${chunk.map((s) => `<figure><figcaption>${esc(s)}</figcaption><img src="${esc(ia.get(`${s}|${grid}`).src)}"></figure>`).join('')}`;
    const f = join(BASE, '_grid.html');
    writeFileSync(f, one);
    await page.goto(pathToFileURL(f).href);
    await page.waitForLoadState('networkidle');
    const png = join(BASE, 'strips', `grid-${BUILD}-${grid}-${String(i / 20 + 1).padStart(2, '0')}.png`);
    await page.screenshot({ path: png, fullPage: true });
    console.log(png);
  }
  await browser.close();
}

// Strips: one PNG per chosen surface (before row over after row, all combos), for review.
const want = arg('png', '');
if (want) {
  mkdirSync(join(BASE, 'strips'), { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1900, height: 400 }, deviceScaleFactor: 1 });
  for (const s of want.split(',')) {
    const one = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:11px system-ui;background:#fff}td{padding:2px;vertical-align:top}img{max-width:185px;max-height:240px;display:block;border:1px solid #888}th{font-weight:600;text-align:left}</style>
<table><tr><th></th>${combos.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${b ? `<tr><th>before</th>${combos.map((c) => cell(ib, s, c)).join('')}</tr>` : ''}<tr><th>${b ? 'after' : ''}</th>${combos.map((c) => cell(ia, s, c)).join('')}</tr></table>`;
    const f = join(BASE, `_strip.html`);
    writeFileSync(f, one);
    await page.goto(pathToFileURL(f).href);
    await page.waitForLoadState('networkidle');
    const png = join(BASE, 'strips', `${BUILD}-${s.replace(/[^a-z0-9._-]+/gi, '_')}.png`);
    await page.locator('table').screenshot({ path: png });
    console.log(png);
  }
  await browser.close();
}
