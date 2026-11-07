// Headless recipe runner (REQ-GAP-01): runs a .gwrecipe.json against the built single file in a
// headless Chromium, with no window and no dialog, and writes the files the recipe produces.
//
//   node tests/tools/headless-recipe.mjs --recipe my.gwrecipe.json --open image.tif [--open pack.gwpack …]
//        [--html dist/gis-workbench.html] [--out out-dir] [--gates continue|fail] [--params params.json]
//
// --recipe may also be a built-in id (airfield-triage, damage-triage, building-extraction).
// Gates: 'continue' (default) passes every review gate; 'fail' stops at the first one. The run's
// status (steps, times, summaries) is printed as JSON and written to <out>/run.json; files the
// recipe saves land in <out>. Exit code 0 when the run is done and ok, 1 otherwise.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const argv = process.argv.slice(2);
const opt = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const all = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));

const html = resolve(opt('html', 'dist/gis-workbench.html'));
const out = resolve(opt('out', 'recipe-out'));
const gates = opt('gates', 'continue');
const recipeArg = opt('recipe');
if (!recipeArg) {
  console.error('give --recipe <file.gwrecipe.json | built-in id>');
  process.exit(2);
}
const recipe = existsSync(recipeArg) ? JSON.parse(readFileSync(recipeArg, 'utf8')) : null;
const params = opt('params') ? JSON.parse(readFileSync(opt('params'), 'utf8')) : {};
const files = all('open').map((f) => resolve(f));
for (const f of files) if (!existsSync(f)) throw new Error(`missing ${f}`);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('gisworkbench.prefs.v1', JSON.stringify({ welcomeDone: true })));
  await page.goto(pathToFileURL(html).href);
  await page.waitForFunction(() => window.gisworkbench?._ready, null, { timeout: 120000 });
  if (files.length) {
    const input = await page.evaluateHandle(() => {
      const i = document.createElement('input');
      i.type = 'file';
      i.multiple = true;
      i.style.display = 'none';
      document.body.appendChild(i);
      return i;
    });
    await input.asElement().setInputFiles(files);
    await page.evaluate(async (i) => {
      const fs = [...i.files];
      i.remove();
      const app = window.gisworkbench;
      const packs = fs.filter((f) => /\.gwpack$/i.test(f.name));
      if (packs.length) await app.openPackFiles(packs);
      const rest = fs.filter((f) => !/\.gwpack$/i.test(f.name));
      if (rest.length) await app.openFiles(rest);
    }, input);
    await page.waitForFunction(() => [...window.gisworkbench.layers.values()].every((l) => l.stats), null, { timeout: 300000 });
  }
  const status = await page.evaluate(async ([recipe, id, gates, params]) => {
    const v2 = window.gisworkbench.api.v2;
    const r = await v2.recipes.run(recipe ? { recipe, gates, params } : { id, gates, params });
    // Files: text inline, binary as base64 for the writer below.
    for (const f of r.files) {
      if (f.blob) {
        const b = new Uint8Array(await f.blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
        f.base64 = btoa(s);
        delete f.blob;
      }
    }
    return r;
  }, [recipe, recipe ? null : recipeArg, gates, params]);
  for (const f of status.files) {
    const p = join(out, basename(f.name));
    writeFileSync(p, f.text !== undefined ? f.text : Buffer.from(f.base64, 'base64'));
    delete f.base64;
    if (f.text !== undefined) f.text = `(${f.text.length} characters written)`;
    f.written = p;
  }
  writeFileSync(join(out, 'run.json'), JSON.stringify(status, null, 1));
  console.log(JSON.stringify(status, null, 1));
  process.exitCode = status.state === 'done' && status.ok ? 0 : 1;
} finally {
  await browser.close();
}
