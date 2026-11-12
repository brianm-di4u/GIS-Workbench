// REG-150: gwb-run's half in the page (sidecar/gwb-sidecar/src/recipe_run_page.js), run in the built
// app the way the runner runs it, with no sidecar or runner. The script uses app internals (the
// import log, layer statistics, recipes.unattended), so a change to them fails here on every PR,
// not only in the sidecar suite.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { resolve } from 'node:path';
import { openApp } from './helpers.js';

const FN = readFileSync(resolve('sidecar', 'gwb-sidecar', 'src', 'recipe_run_page.js'), 'utf8');
const RASTER = resolve('fixtures', 'fx25', 'aviation', 'nodata-utm15n-f32.tif');
const STRETCH = { format: 'gw-recipe/1', name: 'Stretch', steps: [{ op: 'contrast' }] };

/** As recipe_run.rs does: the files on a hidden #gwb-run-inputs, then (FN)(ARGS) as an expression. */
async function runPage(page, args, files = [], before = null) {
  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  if (before) await frame.evaluate(before);
  const input = await frame.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    i.hidden = true;
    i.id = 'gwb-run-inputs';
    document.body.appendChild(i);
    return i;
  });
  if (files.length) await input.asElement().setInputFiles(files);
  const call = { gates: 'continue', params: {}, inputs: files.map(() => 'open'), timeoutMs: 120_000, ...args };
  return frame.evaluate(`(${FN})(${JSON.stringify(call)}).then((r) => r, (e) => ({ threw: String(e?.message ?? e) }))`);
}

test('REG-150 the page script refuses a recipe that would wait for a person', async ({ page }) => {
  const folder = await runPage(page, { id: 'folder-to-cog' });
  expect(folder.refused).toMatch(/step "Convert the folder" \(s1\) opens a dialog/);
});

test('REG-150 the page script refuses a review gate when gates are set to stop', async ({ page }) => {
  const gate = await runPage(page, { id: 'airfield-triage', gates: 'stop' });
  expect(gate.refused).toMatch(/is a review gate/);
});

test('REG-150 the page script opens an --in file before the recipe runs', async ({ page }) => {
  const r = await runPage(page, { recipe: STRETCH }, [RASTER]);
  expect(r.threw).toBeUndefined();
  expect([r.status?.ok, r.status?.steps?.map((s) => s.status)]).toEqual([true, ['done']]);
});

test('REG-150 the page script stops, naming the file, when an --in file does not open', async ({ page }, info) => {
  const junk = info.outputPath('junk.tif');
  writeFileSync(junk, 'not a tiff');
  const r = await runPage(page, { recipe: STRETCH }, [junk]);
  expect(r.threw).toMatch(/an input did not open: junk\.tif: /);
});

test('REG-150 the page script opens an imagery ZIP without asking which file', async ({ page }, info) => {
  const zip = info.outputPath('two.zip');
  const tif = (n) => new Uint8Array(readFileSync(resolve('fixtures', 'fx25', 'aviation', n)));
  writeFileSync(zip, zipSync({ 'a.tif': tif('nodata-utm15n-f32.tif'), 'b.tif': tif('nodata-wgs84-f32.tif') }));
  const r = await runPage(page, { recipe: STRETCH }, [zip]);
  expect(r.threw).toBeUndefined();
  expect(r.status?.ok).toBe(true);
});

test('REG-150 the page script stops, naming it, when opening an input asks a question', async ({ page }) => {
  // An open path with a dialog the runner has no answer for: it fails the run instead of waiting it out.
  const r = await runPage(page, { recipe: STRETCH }, [RASTER], () => {
    window.gisworkbench.openFiles = () => {
      const d = Object.assign(document.createElement('div'), { className: 'dlg' });
      d.setAttribute('aria-modal', 'true');
      d.setAttribute('aria-label', 'Pick a band');
      document.body.appendChild(d);
      return new Promise(() => {});
    };
  });
  expect(r.threw).toBe('opening the inputs asked a question nobody is here to answer: Pick a band');
});

test('REG-150 the page script stops, naming it, when an --in file needs data the run was not given', async ({ page }) => {
  // An RPF table opened alone asks for its folder; going on without the frames would run on nothing.
  const r = await runPage(page, { recipe: STRETCH }, [resolve('fixtures', 'fx21', 'nitf', 'rpf-cib-z3', 'RPF', 'A.TOC')]);
  expect(r.threw).toBe('opening the inputs asked a question nobody is here to answer: Open RPF folder');
});
