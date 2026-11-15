// SCN-94 (SDP-2.8 REG-282): every library recipe in tests/oracles gives the same files from gwb-run
// as from the page, and they match the recipe's committed oracle outputs. SCN-80
// (27-gwb-run.spec.js) checked one recipe this way; this checks the library, case by case.
//
// Runs in the `sidecar` projects. GWB_RUN_EXE is the runner (default: gwb-run beside the test
// sidecar, GWB_SIDECAR_EXE); the suite skips, and says so, when there is none.

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openApp } from '../helpers.js';
import { DATA_ROOT, DIST_DIR, EXE, LINUX } from './harness.js';
import { oracleCases, describeCog, compareCog } from '../../tools/recipe-oracle.mjs';

const RUN = process.env.GWB_RUN_EXE ?? join(dirname(EXE), LINUX ? 'gwb-run' : 'gwb-run.exe');
const WORK = resolve(DATA_ROOT, 'gwb-run-library');

test.skip(!existsSync(RUN), `no gwb-run at ${RUN} (GWB_RUN_EXE)`);
test.describe.configure({ timeout: 300_000 });

/** The app folder as the installer lays it out: the HTML and its SHA256SUMS line. */
function appDir() {
  const dir = join(WORK, 'app');
  mkdirSync(dir, { recursive: true });
  const html = join(DIST_DIR, 'gis-workbench.html');
  copyFileSync(html, join(dir, 'gis-workbench.html'));
  writeFileSync(join(dir, 'SHA256SUMS'), `${createHash('sha256').update(readFileSync(html)).digest('hex')}  gis-workbench.html\n`);
  return dir;
}

for (const c of oracleCases()) {
  test(`SCN-94 ${c.id}: gwb-run gives the page's files, and they match the oracle (${c.provenance.oracle})`, async ({ page }) => {
    rmSync(join(WORK, c.id), { recursive: true, force: true });
    const out = join(WORK, c.id);
    const given = Object.entries(c.case.inputs).flatMap(([step, paths]) => paths.map((p) => [step, resolve(p)]));
    const cli = spawnSync(RUN, [c.case.recipe, '--app-dir', appDir(), '--out', out, ...given.flatMap(([s, p]) => ['--in', `${s}=${p}`])], { encoding: 'utf8', timeout: 240_000, windowsHide: true });
    expect(cli.status, `${cli.stdout}${cli.stderr}`).toBe(0);

    const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
    const el = await frame.evaluateHandle(() => Object.assign(document.body.appendChild(document.createElement('input')), { type: 'file', multiple: true }));
    await el.asElement().setInputFiles(given.map(([, p]) => p));
    const inPage = await frame.evaluate(async ([i, id, steps]) => {
      const params = {};
      [...i.files].forEach((f, k) => (params[steps[k]] ??= { files: [] }).files.push(f));
      const r = await window.gisworkbench.api.v2.recipes.run({ id, params });
      const files = {};
      for (const f of r.files) {
        const b = new Uint8Array(await (f.blob ?? new Blob([f.text])).arrayBuffer());
        let s = '';
        for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode(...b.subarray(k, k + 0x8000));
        files[f.name.split(/[\\/]/).pop()] = btoa(s);
      }
      return { ok: r.ok, files };
    }, [el, c.case.recipe, given.map(([s]) => s)]);
    expect(inPage.ok).toBe(true);

    const written = readdirSync(out).filter((n) => !/^gwb-run\.(log|json)$/.test(n) && !n.endsWith('.gwb-provenance.json'));
    expect(written.sort()).toEqual(Object.keys(c.case.outputs).sort());
    for (const name of written) {
      const bytes = readFileSync(join(out, name));
      expect(bytes.equals(Buffer.from(inPage.files[name], 'base64')), `${name}: the command line's bytes differ from the page's`).toBe(true);
      const o = c.case.outputs[name];
      if (o.kind === 'cog') expect(compareCog(await describeCog(bytes), JSON.parse(readFileSync(join(c.dir, o.oracle), 'utf8'))), `${name} against ${o.oracle}`).toEqual([]);
      expect(JSON.parse(readFileSync(join(out, `${name}.gwb-provenance.json`), 'utf8')).profile).toBe(`recipe ${c.case.recipe}`);
    }
  });
}
