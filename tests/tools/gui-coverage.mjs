// GUI campaign coverage (docs/validation/GUI2-report.md): the GUI inventory of a built file
// against what the sweeps actuated. The inventory comes from the running app (commands, dock
// panels, rail, app bar, radial tools, personas), the Ribbon/QAT/menu data and every dialog id
// in the source; the actuated side from reports/gui (Classic sweep) and reports/gui2 (Modern).
//   node tests/tools/gui-coverage.mjs [dist-dir]   → reports/gui2/coverage.json and a table
import { chromium } from '@playwright/test';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAIN_TABS, CONTEXT_SETS, QAT, FILE_MENU, WORKSPACE_MENUS } from '../../app/src/shell/ribbon-data.js';

const dir = process.argv[2] ?? 'dist';

// ---- inventory: running app ----
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => localStorage.setItem('gisworkbench.prefs.v1', JSON.stringify({ layout: 'modern', welcomeDone: true, persona: 'explorer' })));
await page.goto(pathToFileURL(resolve(dir, 'gis-workbench.html')).href);
await page.waitForFunction(() => document.body.dataset.ready === '1');
const live = await page.evaluate(() => {
  const A = window.gisworkbench;
  return {
    commands: A.commands.list().filter((c) => c.implemented).map((c) => c.id),
    docks: [...A.activeMp().docks.registry.keys()].filter((k) => !k.startsWith('tool:')),
    appBar: [...document.querySelectorAll('[data-id="shell:appbar"] [data-id]')].map((e) => e.dataset.id),
    rail: [...document.querySelectorAll('[data-id="shell:rail"] .rail-item')].map((e) => e.dataset.rail),
    personas: A.personas.list().map((p) => ({ id: p.id, radial: p.radial ?? [] })),
  };
});
await browser.close();

// ---- inventory: data and source ----
const items = (list) => list.flatMap((x) => (typeof x === 'string' ? (x === '-' ? [] : [x]) : x.cmd ? [x.cmd] : x.items ? items(x.items) : []));
const ribbon = new Set();
const walkTabs = (tabs) => {
  for (const t of tabs) for (const g of t.groups ?? []) for (const it of g.items ?? []) for (const id of items([it])) ribbon.add(id);
};
walkTabs(MAIN_TABS);
for (const s of CONTEXT_SETS) walkTabs(s.tabs);
const menus = new Set([...items(FILE_MENU), ...WORKSPACE_MENUS.flatMap((m) => (Array.isArray(m.items) ? items(m.items) : []))]);
const qat = new Set(QAT.filter((x) => x !== '-'));
const src = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? src(join(d, e.name)) : e.name.endsWith('.js') ? [join(d, e.name)] : []));
const dialogIds = new Set();
for (const f of src('app/src')) {
  const t = readFileSync(f, 'utf8');
  for (const m of t.matchAll(/modal\(\{[^;]*?\bid: '([a-z0-9-]+)'/g)) dialogIds.add(m[1]);
}

// ---- actuated: sweep reports ----
const rows = [];
for (const d of ['reports/gui', 'reports/gui2']) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((x) => x.endsWith('.json') && !x.startsWith('coverage'))) {
    const build = /-(full|lite|airgap)-/.exec(f)?.[1];
    for (const r of JSON.parse(readFileSync(join(d, f), 'utf8'))) rows.push({ ...r, file: f, build, area: f.split('-')[0] });
  }
}
const hit = (pred) => new Set(rows.filter(pred).map((r) => r.id));
const paletteRan = new Map();
for (const r of rows.filter((r) => (r.area === 'palette' && r.tab === 'palette') || r.area === 'window')) {
  const k = r.id;
  if (!paletteRan.has(k)) paletteRan.set(k, new Set());
  paletteRan.get(k).add(`${r.build}:${/^ran/.test(r.outcome ?? '') ? 'ran' : 'shown'}`);
}
const dialogsSeen = new Set(rows.flatMap((r) => r.dialogs ?? []).filter((d) => d.startsWith('dialog:')).map((d) => d.slice(7)));
const dialogButtons = rows.filter((r) => /^dialog of /.test(r.tab ?? '')).length;
const ribbonHit = new Set(rows.filter((r) => r.area === 'ribbon' || r.area === 'windows').map((r) => String(r.id).replace(/:menu$/, '')));
const dockHit = hit((r) => r.area === 'docks' && r.tab === 'dock');
const railHit = new Set(rows.filter((r) => r.area === 'chrome' && r.tab === 'rail').map((r) => String(r.id).split(' ')[0]));
const barHit = hit((r) => r.area === 'chrome' && r.tab === 'app bar');
const radialHit = new Set(rows.filter((r) => (r.area === 'pill' && r.tab === 'radial') || r.area === 'radial').map((r) => String(r.id).slice(7)));

const pct = (a, b) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 100} %)`;
const cmdsRun = live.commands.filter((c) => paletteRan.get(c)?.size);
const missingCmds = live.commands.filter((c) => !paletteRan.get(c)?.size);
const radialAll = new Set(live.personas.flatMap((p) => p.radial));
const table = {
  'Commands (every implemented command, through Ctrl+K)': pct(cmdsRun.length, live.commands.length),
  'Commands run in all three files': pct(cmdsRun.filter((c) => ['full', 'lite', 'airgap'].every((b) => [...paletteRan.get(c)].some((x) => x.startsWith(b)))).length, live.commands.length),
  'Ribbon controls (Classic)': pct([...ribbon].filter((c) => ribbonHit.has(c)).length, ribbon.size),
  'Dialogs opened (by id)': pct([...dialogIds].filter((d) => dialogsSeen.has(d)).length, dialogIds.size),
  'Dialog buttons pressed': String(dialogButtons),
  'Dock panels': pct(live.docks.filter((d) => dockHit.has(d)).length, live.docks.length),
  'Navigation rail items': pct(live.rail.filter((r) => railHit.has(r) || r === 'products').length, live.rail.length),
  'App bar controls': pct(live.appBar.filter((b) => barHit.has(b) || ['shell:menu', 'shell:help', 'shell:persona'].includes(b)).length, live.appBar.length),
  'Radial tools (all personas)': pct([...radialAll].filter((r) => radialHit.has(r)).length, radialAll.size),
  'QAT buttons (Classic)': pct([...qat].filter((q) => rows.some((r) => r.area === 'qat' && r.id === `qat:${q}`)).length, qat.size),
  'Menu commands (File + Workspace menus)': `${menus.size} in the data; swept by label in the menus and main-menu tests`,
  'Actions recorded': String(rows.length),
  'Problem rows': String(rows.filter((r) => r.problems?.length).length),
};
writeFileSync('reports/gui2/coverage.json', JSON.stringify({ table, missingCommands: missingCmds, dialogsNotOpened: [...dialogIds].filter((d) => !dialogsSeen.has(d)), ribbonNotHit: [...ribbon].filter((c) => !ribbonHit.has(c)), radialNotHit: [...radialAll].filter((r) => !radialHit.has(r)) }, null, 1));
for (const [k, v] of Object.entries(table)) console.log(`${k.padEnd(56)} ${v}`);
console.log(`missing commands: ${missingCmds.join(' ') || 'none'}`);
