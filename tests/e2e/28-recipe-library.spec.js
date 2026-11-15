// SDP-2.8 §7.1 (REG-282, REG-284, SCN-96): every library recipe in tests/oracles, run in the built
// app on its test fixture:
//   - through gwb-run's page script, it matches the committed oracle outputs within its tolerance;
//   - through recipes.run, it writes the same bytes (gwb-run's own half, the command line, is
//     tests/e2e/sidecar/28-gwb-run-library.spec.js);
//   - it runs on a second, unlike dataset, and its preconditions refuse unsuitable data before
//     anything is written;
//   - the gallery finds it by its name, in the user's words.
// The oracle never runs here: tests/oracles/README.md says how its outputs were made.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openApp } from './helpers.js';
import { oracleCases, describeCog, compareCog } from '../tools/recipe-oracle.mjs';

const FN = readFileSync(resolve('sidecar', 'gwb-sidecar', 'src', 'recipe_run_page.js'), 'utf8');
const INPUT = readFileSync(resolve('sidecar', 'gwb-sidecar', 'src', 'recipe_run_input.js'), 'utf8');
const CASES = oracleCases();

/** Files by step, as gwb-run's --in STEP=FILE gives them: [[step, path], …]. */
const flat = (inputs) => Object.entries(inputs).flatMap(([step, paths]) => paths.map((p) => [step, resolve(p)]));

/** The recipe run as gwb-run runs it: {status, files: {name: Buffer}} or {refused|lost|threw}. */
async function viaGwbRun(page, id, inputs) {
  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  const given = flat(inputs);
  const input = await frame.evaluateHandle(INPUT);
  await input.asElement().setInputFiles(given.map(([, p]) => p));
  const call = { id, gates: 'continue', params: {}, inputs: given.map(([s]) => s), timeoutMs: 120_000 };
  const r = await frame.evaluate(`(${FN})(${JSON.stringify(call)}).then((r) => r, (e) => ({ threw: String(e?.message ?? e) }))`);
  if (!r.status) return r;
  const files = {};
  for (const [i, f] of r.status.files.entries()) {
    const parts = [];
    for (let off = 0; off < f.size; off += 1 << 20) parts.push(Buffer.from(await frame.evaluate(([k, o]) => window.__gwbRun.chunk(k, o, 1 << 20), [i, off]), 'base64'));
    files[f.name] = Buffer.concat(parts);
  }
  return { status: r.status, files, frame };
}

/** The same recipe through recipes.run in a page that has run nothing else: {name: Buffer}. */
async function viaRecipesRun(page, id, inputs) {
  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  const given = flat(inputs);
  const el = await frame.evaluateHandle(() => Object.assign(document.body.appendChild(document.createElement('input')), { type: 'file', multiple: true }));
  await el.asElement().setInputFiles(given.map(([, p]) => p));
  const r = await frame.evaluate(async ([i, id, steps]) => {
    const params = {};
    [...i.files].forEach((f, k) => (params[steps[k]] ??= { files: [] }).files.push(f));
    const s = await window.gisworkbench.api.v2.recipes.run({ id, params });
    const out = {};
    for (const f of s.files) {
      const b = new Uint8Array(await (f.blob ?? new Blob([f.text])).arrayBuffer());
      let t = '';
      for (let k = 0; k < b.length; k += 0x8000) t += String.fromCharCode(...b.subarray(k, k + 0x8000));
      out[f.name] = btoa(t);
    }
    return { ok: s.ok, error: s.error ?? null, files: out };
  }, [el, id, given.map(([s]) => s)]);
  return { ...r, files: Object.fromEntries(Object.entries(r.files).map(([k, v]) => [k, Buffer.from(v, 'base64')])) };
}

async function compare(kind, bytes, oracleFile) {
  const want = JSON.parse(readFileSync(oracleFile, 'utf8'));
  if (kind === 'cog') return compareCog(await describeCog(bytes), want);
  throw new Error(`no comparison for output kind "${kind}"`);
}

for (const c of CASES) {
  test.describe(`REG-284 library recipe ${c.id}`, () => {
    test(`SCN-96 ${c.id} matches its oracle (${c.provenance.oracle}), and recipes.run writes the same bytes as gwb-run's page script`, async ({ page, browser }) => {
      const run = await viaGwbRun(page, c.case.recipe, c.case.inputs);
      expect(run.threw ?? run.refused ?? run.lost).toBeUndefined();
      expect([run.status.ok, run.status.steps.map((s) => s.status)]).toEqual([true, run.status.steps.map(() => 'done')]);
      expect(Object.keys(run.files).sort()).toEqual(Object.keys(c.case.outputs).sort());
      for (const [name, o] of Object.entries(c.case.outputs)) expect(await compare(o.kind, run.files[name], join(c.dir, o.oracle)), `${name} against ${o.oracle}`).toEqual([]);
      const other = await browser.newPage();
      const again = await viaRecipesRun(other, c.case.recipe, c.case.inputs);
      await other.close();
      expect([again.ok, again.error]).toEqual([true, null]);
      for (const [name, bytes] of Object.entries(run.files)) expect(again.files[name]?.equals(bytes), `${name}: recipes.run's bytes differ from the page script's`).toBe(true);
    });

    test(`REG-282 ${c.id} runs on a second, unlike dataset (${c.case.second.why})`, async ({ page }) => {
      const run = await viaGwbRun(page, c.case.recipe, c.case.second.inputs);
      expect(run.threw ?? run.refused ?? run.lost).toBeUndefined();
      expect([run.status.ok, run.status.error ?? null]).toEqual([true, null]);
      expect(Object.keys(run.files).length).toBeGreaterThan(0);
    });

    test(`REG-282 ${c.id} refuses unsuitable input before it writes anything`, async ({ page }) => {
      const run = await viaGwbRun(page, c.case.recipe, c.case.refuse.inputs);
      expect(run.status?.ok).toBe(false);
      expect(run.status.error).toContain(c.case.refuse.reason);
      expect(run.status.files).toEqual([]);
    });

    test(`REG-283 the gallery lists ${c.id} with its explanation, and finds it by its name`, async ({ page }) => {
      const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
      const g = await frame.evaluate((id) => {
        const R = window.gisworkbench.recipes;
        const e = R.gallery().find((x) => x.id === id);
        return { e, found: R.gallery({ search: e?.name ?? '' }).map((x) => x.id) };
      }, c.case.recipe);
      expect(g.e, `${c.id} is not in the gallery`).toBeTruthy();
      expect([!!g.e.category, typeof g.e.lite, !!g.e.explanation.what, !!g.e.explanation.when, !!g.e.explanation.limits]).toEqual([true, 'boolean', true, true, true]);
      expect(g.found).toContain(c.case.recipe);
    });
  });
}
