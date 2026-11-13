// SCN-77 REQ-GAP-84 the workflow builder in the built file: a branching workflow (one road layer
// buffered twice, the narrow buffer erased from the wide one, the ring exported) built in the
// Workflow Builder, edited in its list view, run, saved in the project and the library, and run
// again on another road layer. Its result equals the same tools run one after another by hand.
import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { openApp, openFiles, LEGACY_PREFS } from './helpers.js';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
async function axe(frame, sel) {
  await frame.evaluate(AXE);
  return frame.evaluate(async ([s, tags]) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: tags } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), [sel, AXE_TAGS]);
}

const line = (pts, name) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: { name } });
const ROADS = { type: 'FeatureCollection', features: [line([[-104.99, 39.74], [-104.98, 39.745], [-104.97, 39.743]], 'East'), line([[-104.985, 39.735], [-104.984, 39.75]], 'North')] };
const ROADS2 = { type: 'FeatureCollection', features: [line([[-105.01, 39.70], [-105.0, 39.705]], 'West'), line([[-105.012, 39.698], [-105.008, 39.71]], 'Spur'), line([[-105.02, 39.69], [-105.0, 39.69]], 'South')] };

test('SCN-77 REQ-GAP-84 a branching workflow built, saved in the project and rerun on new inputs', async ({ page }, info) => {
  test.setTimeout(300000);
  const dir = info.outputPath('layers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'roads.geojson'), JSON.stringify(ROADS));
  writeFileSync(join(dir, 'roads2.geojson'), JSON.stringify(ROADS2));
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [join(dir, 'roads.geojson'), join(dir, 'roads2.geojson')]);
  await frame.waitForFunction(() => window.gisworkbench.store.all('vlayer').length >= 2, null, { timeout: 60000 });
  const names = await frame.evaluate(() => window.gisworkbench.store.all('vlayer').map((v) => v.name));

  // The Workflow Builder opens from its command (the lazy block loads), empty.
  await frame.evaluate(() => void window.gisworkbench.commands.run('pip.builder'));
  const panel = frame.locator('.wf-panel');
  await expect(panel).toBeVisible({ timeout: 30000 });
  // A table is several lines: the Builder gives it a multi-line box, and an empty one says so.
  const table = await frame.evaluate(async () => {
    const W = window.gisworkbench.workflows;
    const s = await W.addStep('geocodeTable');
    W.setView('list');
    const tag = document.getElementById(`wf-${s}-text`)?.tagName;
    const r = await window.gisworkbench.recipes.runOp('geocodeTable', { text: '' }).then(() => 'ran', (e) => e.code);
    W.removeStep(s);
    W.setView('graph');
    return { tag, r };
  });
  expect(table).toEqual({ tag: 'TEXTAREA', r: 'E_NEED_ADDRESSES' });
  // Every op's parameters are in its schema, and the list view draws a control for each, with a default or not.
  const controls = await frame.evaluate(async () => {
    const W = window.gisworkbench.workflows;
    const ops = window.gisworkbench.recipes.ops;
    const byDefaults = Object.entries(ops).filter(([, o]) => o.defaults).map(([k]) => k);
    W.setView('list');
    const missing = [];
    for (const op of ['watershed', 'join', 'route']) {
      const s = await W.addStep(op);
      missing.push(...Object.keys(ops[op].schema).filter((k) => !document.getElementById(`wf-${s}-${k}`)).map((k) => `${op}.${k}`));
      W.removeStep(s);
    }
    W.setView('graph');
    return { byDefaults, missing };
  });
  expect(controls).toEqual({ byDefaults: [], missing: [] });
  // A point and a list typed into the list view's fields become a point and a list; a cleared list shows the default it goes back to.
  const [ws, sa] = await frame.evaluate(async () => {
    const W = window.gisworkbench.workflows;
    W.setView('list');
    return [await W.addStep('watershed'), await W.addStep('serviceArea')];
  });
  const at = frame.locator(`[id="wf-${ws}-at"]`);
  const breaks = frame.locator(`[id="wf-${sa}-breaks"]`);
  await at.fill('-121.5, 36.25');
  await at.press('Tab');
  await expect(at).not.toHaveAttribute('aria-invalid', 'true');
  await breaks.fill('120, 240');
  await breaks.press('Tab');
  const typedIn = () =>
    frame.evaluate(([a, b]) => {
      const st = window.gisworkbench.workflows.current().steps;
      return { at: st.find((s) => s.id === a).params.at, breaks: st.find((s) => s.id === b).params.breaks };
    }, [ws, sa]);
  expect(await typedIn()).toEqual({ at: [-121.5, 36.25], breaks: [120, 240] });
  await breaks.fill('');
  await breaks.press('Tab');
  await expect(breaks).toHaveValue('300, 600');
  expect(await typedIn()).toEqual({ at: [-121.5, 36.25], breaks: [300, 600] });
  await frame.evaluate(([a, b]) => {
    const W = window.gisworkbench.workflows;
    W.removeStep(b);
    W.removeStep(a);
    W.setView('graph');
  }, [ws, sa]);
  await expect(panel).toContainText('Add a step to begin');

  // Build: roads → buffer 50 and buffer 200 → erase → export.
  await frame.evaluate((roads) => {
    const W = window.gisworkbench.workflows;
    return (async () => {
      const src = await W.addStep('vectorLayer');
      await W.setParam(src, 'layer', roads);
      const narrow = await W.addStep('buffer');
      const wide = await W.addStep('buffer');
      const ring = await W.addStep('overlay');
      const out = await W.addStep('exportVector');
      await W.wire(src, 'out', narrow, 'layer');
      await W.wire(src, 'out', wide, 'layer');
      await W.wire(wide, 'out', ring, 'a');
      await W.wire(narrow, 'out', ring, 'b');
      await W.wire(ring, 'out', out, 'layer');
      await W.setParam(narrow, 'distance', 50);
      await W.setParam(ring, 'op', 'erase');
    })();
  }, names[0]);
  // The graph: five nodes and five wires.
  await expect(panel.locator('.wf-node')).toHaveCount(5);
  await expect(panel.locator('.wf-wire')).toHaveCount(5);
  // No wire passes behind a step it does not join: every wire's points stay out of the other steps' boxes.
  const hidden = await frame.evaluate(() => {
    const boxes = [...document.querySelectorAll('.wf-node')].map((g) => ({ id: g.dataset.step, r: g.querySelector('rect').getBoundingClientRect() }));
    return [...document.querySelectorAll('.wf-wire')].flatMap((p) => {
      const [from, to] = p.dataset.wire.split('>').map((e) => e.slice(0, e.lastIndexOf('.')));
      const m = p.getScreenCTM();
      const len = p.getTotalLength();
      const hits = new Set();
      for (let i = 1; i < 40; i++) {
        const q = p.getPointAtLength((len * i) / 40).matrixTransform(m);
        for (const b of boxes) if (b.id !== from && b.id !== to && q.x > b.r.left + 2 && q.x < b.r.right - 2 && q.y > b.r.top + 2 && q.y < b.r.bottom - 2) hits.add(`${p.dataset.wire} behind ${b.id}`);
      }
      return [...hits];
    });
  });
  expect(hidden).toEqual([]);
  // A wire that would make a loop is refused, and the workflow is unchanged.
  const loop = await frame.evaluate(async () => {
    try {
      await window.gisworkbench.workflows.wire('s4', 'out', 's2', 'layer');
      return 'wired';
    } catch (e) {
      return e.message;
    }
  });
  expect(loop).toMatch(/loop/);
  // The list view is the keyboard path: the wide buffer's distance typed into its form.
  await frame.evaluate(() => window.gisworkbench.workflows.setView('list'));
  const wideItem = panel.locator('[data-item="s3"]');
  await wideItem.getByLabel('Distance (m)').fill('200');
  await wideItem.getByLabel('Distance (m)').press('Tab');
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.workflows.current().steps.find((s) => s.id === 's3').params.distance)).toBe(200);
  // A cleared field goes back to its default, and shows it.
  await wideItem.getByLabel('Distance (m)').fill('');
  await wideItem.getByLabel('Distance (m)').press('Tab');
  await expect(wideItem.getByLabel('Distance (m)')).toHaveValue('100');
  expect(await frame.evaluate(() => window.gisworkbench.workflows.current().steps.find((s) => s.id === 's3').params.distance)).toBe(100);
  await wideItem.getByLabel('Distance (m)').fill('200');
  await wideItem.getByLabel('Distance (m)').press('Tab');
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.workflows.current().steps.find((s) => s.id === 's3').params.distance)).toBe(200);
  // A value out of range is named where it was typed and not kept.
  await wideItem.getByLabel('Segments per quarter circle').fill('500');
  await wideItem.getByLabel('Segments per quarter circle').press('Tab');
  await expect(wideItem.getByLabel('Segments per quarter circle')).toHaveAttribute('aria-invalid', 'true');
  expect(await axe(frame, '.wf-panel')).toEqual([]);
  // Export… writes the workflow as a file that reads back with the same wires, positions and settings.
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    app.__wfFiles = [];
    app.saveCapture = (blob, name) => app.__wfFiles.push(blob.text().then((text) => ({ name, text })));
  });
  await panel.getByRole('button', { name: 'Export…' }).click();
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.__wfFiles.length)).toBe(1);
  const exported = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.saveCapture = null;
    const { name, text } = await app.__wfFiles[0];
    const file = JSON.parse(text);
    const shape = (r) => JSON.stringify(r.steps.map((s) => [s.id, s.op, s.inputs, s.params, s.at ?? null]));
    return { name, format: file.format, same: shape(app.recipes.validate(file)) === shape(app.recipes.validate(app.workflows.current())), wired: file.steps.filter((s) => Object.values(s.inputs ?? {}).some((w) => 'from' in w)).length };
  });
  expect(exported).toMatchObject({ format: 'gw-recipe/2', same: true });
  expect(exported.name).toMatch(/\.gwrecipe\.json$/);
  expect(exported.wired).toBeGreaterThanOrEqual(2);
  // An input can take a layer of the project instead of a wire, so the workflow runs from the Builder.
  const narrowIn = panel.locator('[data-item="s2"] select[aria-label="Input layer"]');
  await narrowIn.selectOption({ label: `Layer: ${names[0]}` });
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.workflows.current().steps.find((s) => s.id === 's2').inputs.layer)).toEqual({ value: names[0] });
  // A layer the workflow names but the project lacks still shows, and can be cleared.
  await frame.evaluate(() => window.gisworkbench.workflows.give('s2', 'layer', 'roads from elsewhere'));
  await expect(panel.locator('[data-item="s2"] select[aria-label="Input layer"] option:checked')).toHaveText('Layer: roads from elsewhere (not in this project)');
  await panel.locator('[data-item="s2"] select[aria-label="Input layer"]').selectOption({ label: '(given when run)' });
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.workflows.current().steps.find((s) => s.id === 's2').inputs.layer ?? null)).toBeNull();
  await panel.locator('[data-item="s2"] select[aria-label="Input layer"]').selectOption('s1.out');
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.workflows.current().steps.find((s) => s.id === 's2').inputs.layer)).toEqual({ from: 's1', output: 'out' });
  await page.screenshot({ path: info.outputPath('workflow-list.png') });
  await frame.evaluate(() => window.gisworkbench.workflows.setView('graph'));

  // Run it; the ring equals the same tools run by hand, and records where it came from.
  const run = async (roads) =>
    frame.evaluate(async (roads) => {
      const app = window.gisworkbench;
      const saved = [];
      app.saveCapture = (blob, name) => saved.push(name);
      const before = app.undo.history().length;
      const r = await app.workflows.run();
      app.saveCapture = null;
      const undone = app.undo.history().slice(0, app.undo.history().length - before).map((x) => x.label);
      const ring = app.recipes.runner.outputs.get('s4').out;
      const geoms = (id) => app.store.all('feature').filter((f) => f.vlayer === id).map((f) => Array.from(f.geom.xyz).map((x) => Math.round(x * 1e9)));
      // By hand, in a line.
      const id = app.store.all('vlayer').find((v) => v.name === roads).id;
      const a = await app.geoproc.buffer(id, { distance: 50 });
      const b = await app.geoproc.buffer(id, { distance: 200 });
      const c = await app.geoproc.overlay(b, a, 'erase');
      return { r, saved, undone, ring: geoms(ring), byHand: geoms(c), recipe: app.store.get(ring).recipe, states: app.recipes.runner.state.map((s) => s.status), nodes: [...document.querySelectorAll('.wf-node')].map((n) => n.getAttribute('class')) };
    }, roads);
  const first = await run(names[0]);
  expect(first.r).toEqual({ ok: true });
  expect(first.states).toEqual(['done', 'done', 'done', 'done', 'done']);
  expect(first.ring.length).toBeGreaterThan(0);
  expect(first.ring).toEqual(first.byHand);
  expect(first.saved).toHaveLength(1);
  expect(first.saved[0]).toMatch(/\.geojson$/);
  // Run before any Save: the stamp names no version, and says so.
  expect(first.recipe).toMatchObject({ step: 's4', op: 'overlay', params: { op: 'erase' }, version: null, unsaved: true });
  // The stamps are not undo steps: each step's own change is, and Undo takes back a step, not its stamp.
  expect(first.undone.length).toBeGreaterThan(0);
  expect(first.undone.filter((l) => / step s\d/.test(l))).toEqual([]);
  expect(first.nodes.every((c) => /wf-done/.test(c))).toBe(true);
  await page.screenshot({ path: info.outputPath('workflow-graph.png') });

  // Saved in the project and the library; it comes back with the project's records.
  const kept = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const id = await app.workflows.saveToProject();
    const snap = app.store.snapshot();
    const lib = (await app.recipes.library()).map((r) => r.id);
    app.store.load(snap);
    const back = app.store.all('workflow').map((w) => w.recipe.id);
    // API v2 lists what the dock lists.
    const api = (await app.api.v2.recipes.list()).filter((r) => r.id === id);
    return { id, lib, back, inPicker: app.recipes.known().filter((r) => r.id === id).length, api };
  });
  expect(kept.lib).toContain(kept.id);
  expect(kept.back).toEqual([kept.id]);
  expect(kept.inPicker).toBe(1);
  expect(kept.api).toMatchObject([{ id: kept.id, builtin: false }]);
  // Saving again unchanged keeps the version; a change takes the next.
  const versions = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const wf = app.workflows;
    await wf.saveToProject();
    const same = wf.current().version;
    wf.current().description = 'changed';
    await wf.saveToProject();
    const next = wf.current().version;
    const known = () => app.recipes.known().filter((r) => r.id === wf.current().id).map((r) => `${r.source} v${r.version}${r.clash ? ' clash' : ''}`);
    const tie = known();
    // The library gets a different copy under the same id (another project's workflow of that name):
    // both are listed, labelled, and the API refuses the id until a source picks one.
    await app.recipes.keep({ ...JSON.parse(JSON.stringify(wf.current())), version: next + 1, description: 'newer elsewhere' });
    const id = wf.current().id;
    let refused = null;
    await app.api.v2.recipes.run({ id }).catch((e) => (refused = e.code));
    const listed = (await app.api.v2.recipes.list()).filter((r) => r.id === id).map((r) => `${r.source}${r.clash ? ' clash' : ''}`);
    return { same, next, tie, newer: known(), refused, listed, title: wf.current().steps[0].title };
  });
  expect(versions).toEqual({ same: 1, next: 2, tie: ['project v2'], newer: ['project v2 clash', 'library v3 clash'], refused: 'E_RECIPE_AMBIGUOUS', listed: ['project clash', 'library clash'], title: 'Vector layer' });
  // Saving the project's copy now would replace the library's different one: it is saved as a new workflow.
  const saved = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const id = app.workflows.current().id;
    const newId = await app.workflows.saveToProject();
    const lib = (await app.recipes.library()).find((r) => r.id === id);
    return { kept: newId !== id, libraryKept: lib?.description };
  });
  expect(saved).toEqual({ kept: true, libraryKept: 'newer elsewhere' });
  // The Recipes dock labels both copies by where they come from.
  await frame.evaluate(() => window.gisworkbench.commands.run('rcp.open'));
  const labels = await frame.locator('[data-id="recipe:pick"] option').allTextContents();
  expect(labels.filter((x) => /\((project|library)\)$/.test(x))).toHaveLength(2);
  // The Builder's Open lists the same copies as the dock: both, by source.
  await frame.evaluate(() => window.gisworkbench.workflows.show());
  await panel.getByRole('button', { name: 'Open…' }).click();
  const openDlg = frame.locator('[data-id="dialog:wf-open"]');
  await expect(openDlg).toBeVisible();
  const opts = await openDlg.locator('option').allTextContents();
  const clashName = await frame.evaluate(() => window.gisworkbench.recipes.known().find((r) => r.clash)?.name);
  // (The copy just saved as a new workflow has the same name, under its own id.)
  expect(opts).toEqual(expect.arrayContaining([`${clashName} (library)`, `${clashName} (project)`]));
  await openDlg.getByRole('button', { name: 'Cancel' }).click();

  // Rerun on new inputs: the other road layer.
  await frame.evaluate((roads) => window.gisworkbench.workflows.setParam('s1', 'layer', roads), names[1]);
  // Saved first, the run's stamp names the version kept.
  await frame.evaluate(() => window.gisworkbench.workflows.saveToProject());
  const second = await run(names[1]);
  expect(second.r).toEqual({ ok: true });
  expect(second.recipe.version).toBeGreaterThanOrEqual(1);
  expect(second.recipe.unsaved).toBeUndefined();
  expect(second.ring).toEqual(second.byHand);
  expect(second.ring).not.toEqual(first.ring);
  expect(logs).toEqual([]);
});

test('REQ-GAP-84 the graph view by pointer and keyboard: add steps, drag a wire, move, open in the list, delete', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await frame.evaluate(() => void window.gisworkbench.commands.run('pip.builder'));
  const panel = frame.locator('.wf-panel');
  await expect(panel).toBeVisible({ timeout: 30000 });
  // Two steps from the Add a step control.
  await panel.getByLabel('Add a step').selectOption({ label: 'Vector layer' });
  await panel.getByLabel('Add a step').selectOption({ label: 'Buffer' });
  await panel.getByRole('tab', { name: 'Graph' }).click();
  await expect(panel.locator('.wf-node')).toHaveCount(2);
  // Drag from the first step's output to the second step's input.
  const from = await panel.locator('[data-step="s1"] .wf-out').boundingBox();
  const to = await panel.locator('[data-step="s2"] .wf-in').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(panel.locator('.wf-wire')).toHaveCount(1);
  expect(await frame.evaluate(() => window.gisworkbench.workflows.current().steps[1].inputs.layer)).toEqual({ from: 's1', output: 'out' });
  // The keyboard: an arrow moves the focused node, Enter opens it in the list.
  const node = panel.locator('[data-step="s2"]');
  const x0 = await frame.evaluate(() => window.gisworkbench.workflows.current().steps[1].at.x);
  await node.focus();
  await page.keyboard.press('ArrowRight');
  expect(await frame.evaluate(() => window.gisworkbench.workflows.current().steps[1].at.x)).toBe(x0 + 10);
  await expect(panel.locator('[data-step="s2"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel.locator('[data-item="s2"]')).toBeFocused();
  // Back in the graph, Delete removes the focused step and its wire.
  await panel.getByRole('tab', { name: 'Graph' }).click();
  await panel.locator('[data-step="s2"]').focus();
  await page.keyboard.press('Delete');
  await expect(panel.locator('.wf-node')).toHaveCount(1);
  await expect(panel.locator('.wf-wire')).toHaveCount(0);
  expect(logs).toEqual([]);
});

test('REQ-PIP-02 REQ-PIP-03 REQ-GAP-84 the Recipes dock runs a gw-recipe/1 chain on the new runner, workflow states follow their steps, and the API gives open inputs', async ({ page }, info) => {
  test.setTimeout(240000);
  const dir = info.outputPath('layers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'roads.geojson'), JSON.stringify(ROADS));
  const chain = join(dir, 'chain.gwrecipe.json');
  writeFileSync(chain, JSON.stringify({ format: 'gw-recipe/1', id: 'chain-test', name: 'Chain test', steps: [{ op: 'gate', title: 'Look first', params: { message: 'Look' } }, { op: 'exportGeojson', params: { what: 'outlines' } }] }));
  // Opens go through a file input.
  await page.addInitScript(() => delete window.showOpenFilePicker);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [join(dir, 'roads.geojson')]);
  await frame.waitForFunction(() => window.gisworkbench.store.all('vlayer').length >= 1, null, { timeout: 60000 });
  const roads = await frame.evaluate(() => window.gisworkbench.store.all('vlayer')[0].id);
  // Two layers of one name: a workflow input naming it is refused, not run on the first; by id it runs.
  const twin = await frame.evaluate(async (id) => {
    const app = window.gisworkbench;
    const name = app.store.get(id).name;
    const b = await app.geoproc.buffer(id, { distance: 10 });
    app.store.transact('test', (tx) => tx.set(b, 'name', name));
    const run = (layer) => app.recipes.runOp('dissolve', {}, { layer }).then(() => 'ran', (e) => e.code);
    const r = { byName: await run(name), byId: await run(id) };
    app.store.transact('test', (tx) => tx.set(b, 'name', `${name} buffered`));
    return r;
  }, roads);
  expect(twin).toEqual({ byName: 'E_RECIPE_INPUT', byId: 'ran' });

  // A gw-recipe/1 file opened in the Recipes dock runs as a chain: it waits at its gate, Enter
  // continues, a changed parameter makes its step stale, and Re-run from here runs it again.
  await frame.evaluate(() => window.gisworkbench.commands.run('rcp.open'));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), frame.locator('[data-id="recipe:open"]').click()]);
  await chooser.setFiles(chain);
  const steps = frame.locator('[data-id="recipe:steps"] li');
  await expect(steps).toHaveCount(2);
  // The same id in another file with other content does not replace the one kept: it opens beside it.
  const other = join(dir, 'chain-other.gwrecipe.json');
  writeFileSync(other, JSON.stringify({ format: 'gw-recipe/1', id: 'chain-test', name: 'Chain test', steps: [{ op: 'gate', params: { message: 'Look again' } }] }));
  const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), frame.locator('[data-id="recipe:open"]').click()]);
  await chooser2.setFiles(other);
  await expect(steps).toHaveCount(1);
  const kept = () => frame.evaluate(async () => (await window.gisworkbench.recipes.library(true)).filter((r) => r.id.startsWith('chain-test')).map((r) => [r.id === 'chain-test', r.steps.length]).sort());
  expect(await kept()).toEqual([[false, 1], [true, 2]]);
  // Opened again (by the same call the dock makes, awaited), it is the copy already kept, not one more.
  const importText = (text) => frame.evaluate((t) => window.gisworkbench.recipes.importFile(new File([t], 'f.gwrecipe.json')), text);
  await importText(readFileSync(other, 'utf8'));
  expect(await kept()).toEqual([[false, 1], [true, 2]]);
  // A file under a built-in's id is kept under an id of its own, and listed.
  await importText(JSON.stringify({ format: 'gw-recipe/1', id: 'damage-triage', name: 'My triage', steps: [{ op: 'gate', params: { message: 'Mine' } }] }));
  expect(await frame.evaluate(() => window.gisworkbench.recipes.known().filter((r) => r.id.startsWith('damage-triage')).map((r) => [r.id === 'damage-triage', r.source]).sort())).toEqual([[false, 'library'], [true, 'builtin']]);
  // A built-in's own content opens the built-in and keeps nothing; the same workflow at an older version
  // does not take the kept one back.
  const after = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const b = app.recipes.builtin.find((r) => r.id === 'airfield-triage');
    await app.recipes.importFile(new File([JSON.stringify(b)], 'b.gwrecipe.json'));
    const builtinCopies = app.recipes.known().filter((r) => r.id.startsWith('airfield-triage')).map((r) => r.source);
    const kept = (await app.recipes.library(true)).find((r) => r.id === 'chain-test');
    await app.recipes.keep({ ...kept, version: 5 });
    await app.recipes.importFile(new File([JSON.stringify({ ...kept, version: 1 })], 'c.gwrecipe.json'));
    return { builtinCopies, version: (await app.recipes.library(true)).find((r) => r.id === 'chain-test').version };
  });
  expect(after).toEqual({ builtinCopies: ['builtin'], version: 5 });
  const [chooser3] = await Promise.all([page.waitForEvent('filechooser'), frame.locator('[data-id="recipe:open"]').click()]);
  await chooser3.setFiles(chain);
  await expect(steps).toHaveCount(2);
  await frame.locator('[data-id="recipe:run"]').click();
  await expect(steps.nth(0)).toHaveAttribute('data-status', 'waiting', { timeout: 30000 });
  await expect(steps.nth(1)).toHaveAttribute('data-status', 'pending');
  await frame.locator('body').press('Enter');
  await expect(steps.nth(1)).toHaveAttribute('data-status', 'done');
  await expect(steps.nth(1)).toContainText('no outlines');
  await steps.nth(1).click();
  await frame.locator('[data-id="recipe:param:what"]').fill('accepted-detections');
  await frame.locator('[data-id="recipe:param:what"]').press('Tab');
  await expect(steps.nth(1)).toHaveAttribute('data-status', 'stale');
  await expect(steps.nth(0)).toHaveAttribute('data-status', 'done');
  await frame.locator('[data-id="recipe:rerun"]').click();
  await expect(steps.nth(1)).toHaveAttribute('data-status', 'done');
  await expect(steps.nth(1)).toContainText('no accepted detections');
  expect(await frame.evaluate(() => window.gisworkbench.recipes.runner.toJSON().format)).toBe('gw-recipe/2');
  // Every parameter an op offers has a schema entry, so the Builder's form and the dock coerce it alike:
  // the time series and routing ops' form text becomes points, lists and booleans.
  const typed = await frame.evaluate(
    () =>
      window.gisworkbench.recipes.validate({
        format: 'gw-recipe/2',
        id: 'net',
        name: 'Net',
        steps: [
          { id: 'a', op: 'serviceArea', params: { at: '-120, 35', breaks: '300, 600, 900' } },
          { id: 'b', op: 'timeAnomaly', params: { z: 'false', by: 'none' } },
          { id: 'c', op: 'route', params: { from: '-120, 35', to: [-119.9, 35.1] } },
        ],
      }).steps.map((s) => s.params),
  );
  expect(typed).toEqual([{ at: [-120, 35], breaks: [300, 600, 900] }, { from: '', to: '', by: 'none', z: false }, { from: [-120, 35], to: [-119.9, 35.1] }]);
  // Save… in the dock writes that file, with the parameter changed in the drawer.
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    app.__recipeFiles = [];
    app.saveCapture = (blob, name) => app.__recipeFiles.push(blob.text().then((text) => ({ name, text })));
  });
  await frame.locator('[data-id="recipe:save"]').click();
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.__recipeFiles.length)).toBe(1);
  const file = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.saveCapture = null;
    const { name, text } = await app.__recipeFiles[0];
    return { name, r: JSON.parse(text) };
  });
  expect(file.name).toBe('chain-test.gwrecipe.json');
  expect(file.r).toMatchObject({ format: 'gw-recipe/2', id: 'chain-test', name: 'Chain test' });
  expect(file.r.steps.map((s) => [s.op, s.title ?? null, s.params])).toEqual([
    ['gate', 'Look first', { message: 'Look' }],
    ['exportGeojson', expect.anything(), { what: 'accepted-detections' }],
  ]);

  // The dock's form gives a list as text; the op's schema turns it into numbers.
  await frame.evaluate(() => window.gisworkbench.recipes.open({ format: 'gw-recipe/2', id: 'ws-test', name: 'Watershed test', steps: [{ id: 'w', op: 'watershed', params: { at: [-120, 35], snap: 50 } }] }));
  await steps.nth(0).click();
  const at = frame.locator('[data-id="recipe:param:at"]');
  await at.fill('-121.5, 36.25');
  await at.press('Tab');
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.recipes.runner.recipe.steps[0].params.at)).toEqual([-121.5, 36.25]);
  await expect(at).not.toHaveAttribute('aria-invalid', 'true');
  await at.fill('east of here');
  await at.press('Tab');
  await expect(at).toHaveAttribute('aria-invalid', 'true');
  expect(await frame.evaluate(() => window.gisworkbench.recipes.runner.recipe.steps[0].params.at)).toEqual([-121.5, 36.25]);

  // In the builder, a step's run state stays with that step when an earlier step is removed.
  await frame.evaluate(() => void window.gisworkbench.commands.run('pip.builder'));
  const panel = frame.locator('.wf-panel');
  await expect(panel).toBeVisible({ timeout: 30000 });
  const run = await frame.evaluate(async (id) => {
    const W = window.gisworkbench.workflows;
    const src = await W.addStep('vectorLayer');
    await W.setParam(src, 'layer', id);
    const buf = await W.addStep('buffer');
    const ov = await W.addStep('overlay');
    await W.wire(src, 'out', buf, 'layer');
    await W.wire(buf, 'out', ov, 'a');
    // Overlay's second input is left open, so it fails.
    return W.run();
  }, roads);
  expect(run).toMatchObject({ ok: false, failed: 2 });
  await frame.evaluate(() => window.gisworkbench.workflows.setView('list'));
  await expect(panel.locator('[data-item="s3"] .wf-badge')).toHaveText('failed');
  await expect(panel.locator('[data-item="s3"] .wf-error')).toBeVisible();
  await frame.evaluate(() => window.gisworkbench.workflows.removeStep('s2'));
  await expect(panel.locator('[data-item="s1"] .wf-badge')).toHaveText('done');
  await expect(panel.locator('[data-item="s3"] .wf-badge')).toHaveText('failed');
  await expect(panel.locator('[data-item="s3"] .wf-error')).toBeVisible();

  // API v2: an input left unwired is given when the workflow runs; a wired workflow runs from its first step.
  const api = await frame.evaluate(async (id) => {
    const v2 = window.gisworkbench.api.v2;
    const recipe = { format: 'gw-recipe/2', id: 'open-input', name: 'Open input', steps: [{ id: 'b', op: 'buffer', params: { distance: 30 } }, { id: 'e', op: 'exportVector', inputs: { layer: { from: 'b', output: 'out' } }, params: { format: 'geojson' } }] };
    const ok = await v2.recipes.run({ recipe, inputs: { 'b.layer': id } });
    let later;
    try {
      later = await v2.recipes.run({ recipe, inputs: { 'b.layer': id }, from: 1 });
    } catch (e) {
      later = e.message;
    }
    // One typed op alone, its input given by name.
    const op = await v2.recipes.op({ op: 'buffer', params: { distance: 30 }, inputs: { layer: id } });
    return { ok: ok.ok, files: ok.files.map((f) => f.name), later, op: op.summary };
  }, roads);
  expect(api.ok).toBe(true);
  expect(api.files).toHaveLength(1);
  expect(api.later).toMatch(/from its first step/);
  expect(api.op).not.toBe('');

  // A built-in opened in the builder is saved under an id of its own, so the built-in never hides
  // it; the dock lists each id once, and removing it from the library removes it from the list.
  const own = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const b = app.recipes.builtin[0];
    app.workflows.open(b);
    const id = await app.workflows.saveToProject();
    const ids = app.recipes.known().map((r) => r.id);
    app.store.transact('drop', (tx) => app.store.all('workflow').forEach((w) => tx.delete(w.id)));
    const inLib = (await app.recipes.library()).some((r) => r.id === id);
    await app.workflows.removeFromLibrary(id);
    return { builtin: b.id, id, unique: new Set(ids).size === ids.length, listed: ids.includes(id), inLib, after: app.recipes.known().some((r) => r.id === id) };
  });
  expect(own.id).not.toBe(own.builtin);
  expect(own).toMatchObject({ unique: true, listed: true, inLib: true, after: false });
  expect(logs).toEqual([]);
});

// The recipes the settings kept (before the library) move into the library on the first start, and
// the settings list is emptied only once they are there. Without IndexedDB they stay, and are listed.
const OLD = [1, 2].map((n) => ({ format: 'gw-recipe/1', id: `old-${n}`, name: `Old recipe ${n}`, steps: [{ op: 'gate', title: 'Look', params: { message: 'Look' } }] }));
test('REQ-GAP-84 recipes kept in the settings move into the library on the first start', async ({ page }) => {
  const { frame } = await openApp(page, 'file', { prefs: { ...LEGACY_PREFS, recipes: OLD } });
  const out = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const lib = (await app.recipes.library()).map((r) => r.id);
    const listed = (await app.api.v2.recipes.list()).map((r) => r.id);
    return { lib, known: app.recipes.known().map((r) => r.id), listed, left: app.prefs.get('recipes') };
  });
  expect(out.lib).toEqual(expect.arrayContaining(['old-1', 'old-2']));
  expect(out.known).toEqual(expect.arrayContaining(['old-1', 'old-2']));
  expect(out.listed).toEqual(expect.arrayContaining(['old-1', 'old-2']));
  // The settings keep their list (an older build still finds it); the library's copies are what is shown.
  expect(out.left.map((r) => r.id)).toEqual(expect.arrayContaining(['old-1', 'old-2']));
  // Opening a library copy and saving it replaces it in place: unchanged keeps its version, a change takes the next.
  const saves = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const old = (await app.recipes.library()).find((r) => r.id === 'old-1');
    app.workflows.open(old);
    const a = await app.workflows.saveToProject();
    const v1 = app.workflows.current().version;
    app.workflows.current().description = 'edited here';
    const b = await app.workflows.saveToProject();
    const lib = (await app.recipes.library()).filter((r) => r.id.startsWith('old-1'));
    const proj = app.store.all('workflow').map((w) => `${w.recipe.id} v${w.recipe.version}`);
    // Another tab saves a different copy of old-1 to the library; this tab has not read it.
    await new Promise((res, rej) => {
      const q = indexedDB.open('gw-workflows', 1);
      q.onsuccess = () => {
        const tx = q.result.transaction('workflows', 'readwrite');
        tx.objectStore('workflows').put({ id: 'old-1', recipe: { ...JSON.parse(JSON.stringify(app.workflows.current())), description: 'other tab' }, saved: new Date().toISOString() });
        tx.oncomplete = () => (q.result.close(), res());
        tx.onerror = () => rej(tx.error);
      };
      q.onerror = () => rej(q.error);
    });
    app.workflows.current().description = 'edited again here';
    const c = await app.workflows.saveToProject();
    const other = (await app.recipes.library(true)).find((r) => r.id === 'old-1')?.description;
    return { a, b, v1, v2: lib.find((r) => r.id === 'old-1')?.version, rows: lib.length, desc: lib[0]?.description, proj, forked: c !== 'old-1', other };
  });
  expect(saves).toEqual({ a: 'old-1', b: 'old-1', v1: 1, v2: 2, rows: 1, desc: 'edited here', proj: ['old-1 v2'], forked: true, other: 'other tab' });
  // A library copy changed before its first save here takes the next version; two saves at once make one record.
  const first = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.workflows.open((await app.recipes.library()).find((r) => r.id === 'old-2'));
    app.workflows.current().description = 'changed before the first save';
    const ids = await Promise.all([app.workflows.saveToProject(), app.workflows.saveToProject()]);
    const lib = (await app.recipes.library(true)).find((r) => r.id === 'old-2');
    return { ids, lib: lib.version, proj: app.store.all('workflow').filter((w) => w.recipe.id === 'old-2').map((w) => w.recipe.version) };
  });
  expect(first).toEqual({ ids: ['old-2', 'old-2'], lib: 2, proj: [2] });
  // A library copy that differs only in where its steps sit is the same workflow: no clash.
  const layoutOnly = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const lib = (await app.recipes.library(true)).find((r) => r.id === 'old-2');
    await app.recipes.keep({ ...lib, steps: lib.steps.map((s, k) => ({ ...s, at: { x: 500 + k, y: 7 } })) });
    return app.recipes.known().filter((r) => r.id === 'old-2').map((r) => `${r.source}${r.clash ? ' clash' : ''}`);
  });
  expect(layoutOnly).toEqual(['project']);
});
test('REQ-GAP-84 without IndexedDB the settings keep their recipes, and the picker still lists them', async ({ page }) => {
  await page.addInitScript(() => {
    delete window.indexedDB;
  });
  const { frame } = await openApp(page, 'file', { prefs: { ...LEGACY_PREFS, recipes: OLD } });
  const out = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    await app.recipes.library();
    return { known: app.recipes.known().map((r) => r.id), left: app.prefs.get('recipes').map((r) => r.id) };
  });
  expect(out.left).toEqual(['old-1', 'old-2']);
  expect(out.known).toEqual(expect.arrayContaining(['old-1', 'old-2']));
});
