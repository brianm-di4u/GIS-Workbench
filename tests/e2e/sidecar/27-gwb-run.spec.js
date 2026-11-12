// SCN-80 (REG-150, REQ-GAP-95): a recipe run from the command line gives the same outputs as the
// same run in the page. gwb-run starts the installed browser headless over a DevTools pipe and runs
// recipes.run in the verified app; here the page run is the same API call made by Playwright.
//
// Runs in the `sidecar` projects. GWB_RUN_EXE is the runner (default: gwb-run beside the test
// sidecar, GWB_SIDECAR_EXE); the suite skips when there is none.

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { openApp } from '../helpers.js';
import { DATA_ROOT, DIST_DIR, EXE, LINUX } from './harness.js';

const RUN = process.env.GWB_RUN_EXE ?? join(dirname(EXE), LINUX ? 'gwb-run' : 'gwb-run.exe');
const DIST = join(DIST_DIR, 'gis-workbench.html');
const WORK = resolve(DATA_ROOT, 'gwb-run-work');
const INPUTS = [resolve('fixtures', 'fx25', 'aviation', 'nodata-utm15n-f32.tif'), resolve('fixtures', 'fx12', 'fx12.geojson')];

test.skip(!existsSync(RUN), `no gwb-run at ${RUN} (GWB_RUN_EXE)`);
test.describe.configure({ timeout: 300_000 });

/** An app folder as the installer lays it out: the HTML and its SHA256SUMS line. */
function appDir() {
  const dir = join(WORK, 'app');
  mkdirSync(dir, { recursive: true });
  copyFileSync(DIST, join(dir, 'gis-workbench.html'));
  const sum = createHash('sha256').update(readFileSync(DIST)).digest('hex');
  writeFileSync(join(dir, 'SHA256SUMS'), `${sum}  gis-workbench.html\n`);
  return dir;
}

function gwbRun(args) {
  const r = spawnSync(RUN, args, { encoding: 'utf8', timeout: 240_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('SCN-80 a recipe run from the command line gives the same files as the run in the page', async ({ page }) => {
  rmSync(WORK, { recursive: true, force: true });
  const app = appDir();
  const out = join(WORK, 'out');
  const cli = gwbRun(['folder-to-cog', '--app-dir', app, '--out', out, ...INPUTS.flatMap((f) => ['--in', `s1=${f}`])]);
  expect(cli.code, cli.out).toBe(0);
  expect(cli.out).toMatch(/s1 done/);

  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  const input = await frame.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles(INPUTS);
  const inPage = await frame.evaluate(async (i) => {
    const r = await window.gisworkbench.api.v2.recipes.run({ id: 'folder-to-cog', params: { s1: { files: [...i.files] } } });
    const files = [];
    for (const f of r.files) {
      const b = new Uint8Array(await (f.blob ?? new Blob([f.text])).arrayBuffer());
      let s = '';
      for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode(...b.subarray(k, k + 0x8000));
      files.push({ name: f.name, base64: btoa(s) });
    }
    return { ok: r.ok, files };
  }, input);
  expect(inPage.ok).toBe(true);

  const written = readdirSync(out).filter((n) => !/^gwb-run\.(log|json)$/.test(n) && !n.endsWith('.gwb-provenance.json'));
  expect(written.sort()).toEqual(inPage.files.map((f) => basename(f.name)).sort());
  for (const f of inPage.files) {
    const mine = readFileSync(join(out, basename(f.name)));
    expect(mine.equals(Buffer.from(f.base64, 'base64')), `${f.name}: the command line's bytes differ from the page's`).toBe(true);
    const prov = JSON.parse(readFileSync(join(out, `${basename(f.name)}.gwb-provenance.json`), 'utf8'));
    expect(prov.profile).toBe('recipe folder-to-cog');
    expect(prov.inputs).toEqual(INPUTS.map((p) => `s1=${basename(p)}`));
    expect(prov.steps.map((s) => [s.tool, s.args[1]])).toEqual([['convertFolder', 'done']]);
  }
  const record = JSON.parse(readFileSync(join(out, 'gwb-run.json'), 'utf8'));
  expect([record.state, record.ok, record.files.length]).toEqual(['done', true, inPage.files.length]);
  expect(readFileSync(join(out, 'gwb-run.log'), 'utf8')).toMatch(/exit 0/);
});

test('REG-150 a step that needs a dialog, or a gate set to stop, is refused before anything runs', () => {
  const app = existsSync(join(WORK, 'app', 'SHA256SUMS')) ? join(WORK, 'app') : appDir();
  const out = join(WORK, 'refused');
  const gate = gwbRun(['airfield-triage', '--app-dir', app, '--out', out, '--gates', 'stop']);
  expect(gate.code, gate.out).toBe(4);
  expect(gate.out).toMatch(/step "Review the detections" \(s3\) is a review gate/);
  const folder = gwbRun(['folder-to-cog', '--app-dir', app, '--out', out]);
  expect(folder.code, folder.out).toBe(4);
  expect(folder.out).toMatch(/step "Convert the folder" \(s1\) opens a dialog/);
  const unknown = gwbRun(['folder-to-cog', '--app-dir', app, '--out', out, '--in', `s9=${INPUTS[0]}`]);
  expect(unknown.code, unknown.out).toBe(4);
  expect(unknown.out).toMatch(/the recipe has no step "s9" \(its steps: s1\)/);
  mkdirSync(join(WORK, 'r'), { recursive: true });
  const cmd = join(WORK, 'r', 'cmd.gwrecipe.json');
  writeFileSync(cmd, JSON.stringify({ format: 'gw-recipe/1', name: 'Command', steps: [{ op: 'contrast' }, { op: 'command', id: 'open', params: { id: 'file.open' } }] }));
  const command = gwbRun([cmd, '--app-dir', app, '--out', out]);
  expect(command.code, command.out).toBe(4);
  expect(command.out).toMatch(/step "Run a command" \(open\) runs a command, which may open a dialog/);
  // Nothing ran, so nothing but the log is in the output folder.
  expect(readdirSync(out)).toEqual(['gwb-run.log']);
});

test('REG-150 a file given with a plain --in opens in the app first, and one it cannot open stops the run', () => {
  const app = existsSync(join(WORK, 'app', 'SHA256SUMS')) ? join(WORK, 'app') : appDir();
  mkdirSync(join(WORK, 'r'), { recursive: true });
  const stretch = join(WORK, 'r', 'stretch.gwrecipe.json');
  writeFileSync(stretch, JSON.stringify({ format: 'gw-recipe/1', name: 'Stretch', steps: [{ op: 'contrast' }] }));
  const out = join(WORK, 'opened');
  // The contrast step needs an image layer: it runs only if the raster opened first.
  const good = gwbRun([stretch, '--app-dir', app, '--out', out, '--in', INPUTS[0]]);
  expect(good.code, good.out).toBe(0);
  expect(good.out).toMatch(/s1 done/);
  expect(JSON.parse(readFileSync(join(out, 'gwb-run.json'), 'utf8')).ok).toBe(true);
  const junk = join(WORK, 'r', 'junk.tif');
  writeFileSync(junk, 'not a tiff');
  const bad = gwbRun([stretch, '--app-dir', app, '--out', out, '--in', junk]);
  expect(bad.code, bad.out).toBe(1);
  expect(bad.out).toMatch(/an input did not open: junk\.tif: /);
  // The status left is not the good run's.
  expect(existsSync(join(out, 'gwb-run.json'))).toBe(false);
});
