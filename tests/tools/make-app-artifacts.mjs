// Real app-written supporting files for the T&E archive (TE-corpus/derived-app-artifacts): projects
// (.gwb) saved after opening corpus data, every built-in recipe (.gwrecipe.json) and template
// (.gwt.json) exported through the app's own save paths, and the current build's data packs
// (.gwpack). Run against a built dist/; re-run after a release because packs embed minTool.
//
//   node tests/tools/make-app-artifacts.mjs [--dist dist]

import { chromium } from 'playwright';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openApp, openFiles } from '../e2e/helpers.js';

const ROOT = resolve('.');
const dist = process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1] : 'dist';
const CORPUS = resolve(process.env.TE_CORPUS ?? join(ROOT, '..', 'TE-corpus'));
const ID = 'derived-app-artifacts';
const OUT = join(CORPUS, ID);
mkdirSync(OUT, { recursive: true });
const C = (...p) => join(CORPUS, ...p);
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const projects = [
  ['naip_vegas_buildings', [C('derived-gtiff-variants', 'naip_gcps.tif'), join(ROOT, '..', 'Research', 'samples', 'msi-spacenet2-wv3', 'SN2_buildings_train_AOI_2_Vegas_geojson_buildings_img10.geojson')]],
  ['umbra_sicd_chip', [C('sar-osml-sicd-sidd-chips', 'umbra-sicd121-chip1.ntf')]],
  ['colorado_dem_dted2', [C('derived-dted-level2', 'copernicus', 'w106', 'n39.dt2'), C('derived-hgt-variants', 'srtm3-1201', 'N39W106.hgt')]],
];

const browser = await chromium.launch({ channel: 'chrome', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] }); // as playwright.config.js
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
// Saves become downloads (as tests/e2e/pip-p6.spec.js).
await page.addInitScript(() => {
  delete window.showSaveFilePicker;
  delete window.showOpenFilePicker;
});
const { frame } = await openApp(page, 'file', { htmlPath: join(ROOT, dist, 'gis-workbench.html'), prefs: { welcomeDone: true } });
const files = [];
const save = async (trigger, name) => {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), trigger()]);
  await dl.saveAs(join(OUT, name));
  files.push({ name, url: null, role: 'primary' });
  return name;
};

for (const [tag, paths] of projects) {
  await frame.evaluate(() => window.gisworkbench.commands.run('file.newproject')).catch(() => {});
  await openFiles(frame, paths.filter(existsSync));
  await frame.waitForTimeout(3000);
  await frame.evaluate((n) => window.gisworkbench.store?.transact?.('Name', (tx) => tx.set('project', 'name', n), { kind: 'load' }), tag).catch(() => {});
  await save(() => frame.evaluate(() => window.gisworkbench.commands.run('file.saveas')), `${tag}.gwb`);
}

const recipes = await frame.evaluate(() => window.gisworkbench.recipes.builtin.map((r) => r.id));
await frame.evaluate(() => window.gisworkbench.commands.run('rcp.open'));
for (const id of recipes) {
  await frame.evaluate((i) => {
    const app = window.gisworkbench;
    app.recipes.open(app.recipes.builtin.find((r) => r.id === i));
  }, id);
  await save(() => frame.locator('[data-id="recipe:save"]').first().click(), `${id}.gwrecipe.json`);
}

for (const k of ['sheet', 'slide', 'chip']) { // BUILTIN_TEMPLATES in app/src/products/template.js
  await frame.evaluate((key) => window.gisworkbench.prefs.set('templateActive', `builtin:${key}`), k);
  await save(() => frame.evaluate(() => window.gisworkbench.commands.run('tpl.saveas')), `template_${k}.gwt.json`);
}
await browser.close();

for (const p of ['proj-0.1.0.gwpack', 'hdf5-0.10.3.gwpack', 'geoid-2008.5min.gwpack', 'ai-1.30.0+slimsam77.webgpu.gwpack']) {
  const src = join(ROOT, dist, 'packs', p);
  if (!existsSync(src)) continue;
  copyFileSync(src, join(OUT, p));
  files.push({ name: p, url: null, role: 'primary' });
}

const entry = {
  id: ID,
  area: 'raster',
  title: `App-written supporting files from GIS Workbench ${version}: projects (.gwb), built-in recipes (.gwrecipe.json), templates (.gwt.json), data packs (.gwpack)`,
  source: `Derived (GIS Workbench ${version} ${dist}/gis-workbench.html, Playwright)`,
  landing: 'tests/tools/make-app-artifacts.mjs',
  licence: 'Project files reference public corpus data; packs carry their own licences (see pack.json)',
  attribution: 'GIS Workbench',
  tier: 'A',
  origin: 'derived',
  format: 'GWB / GWRECIPE / GWT / GWPACK',
  profile: `Written by the app's own save paths; packs copied from ${dist}/packs (minTool ${version})`,
  files,
  sign: null,
  derivation: `node tests/tools/make-app-artifacts.mjs --dist ${dist}`,
  notes: 'Packs embed minTool and hashes per release: regenerate after each release. Projects reference imagery by fingerprint (relink needed on another machine).',
  feeds: ['file.openproject', 'packs.manage', 'tpl.apply', 'rcp.import'],
  covers: [],
  pairs: [],
};
const srcFile = join(ROOT, 'build', 'campaign', 'sources', 'archive-derived.json');
const all = existsSync(srcFile) ? JSON.parse(readFileSync(srcFile, 'utf8')) : [];
const i = all.findIndex((e) => e.id === ID);
if (i >= 0) all[i] = entry;
else all.push(entry);
writeFileSync(srcFile, JSON.stringify(all, null, 1));
console.log(`${ID}: ${files.map((f) => f.name).join(', ')}`);
