// 2.4 gap wave T0a, group extai (SDP-2.3 GR-01, GR-20, GR-21):
//   REQ-GAP-01 automation API v2 in the app (parameters, no dialog, events, MCP, v1 unchanged,
//              the headless recipe runner);
//   REQ-GAP-52 a user JSON feature catalogue imported from the UI, kept in the project and settings;
//   REQ-GAP-53 conditional rules, subtypes and contingent domains in the form and validation;
//              catalogues from data packs;
//   REQ-GAP-56 WebGPU fp16: the SAM 2.1 encoder timing on this machine and the fp16 outlines'
//              accuracy, open-vocabulary detection over a scene as a job (cancel included);
//   REQ-GAP-57 user ONNX models (hash, licence, input spec; refusals), the land-cover model,
//              VLM drafts (REQ-LAI-04, D30) and the change mask (REQ-LAI-05).
// AI tests need the packs of this build (dist-extai/packs) and skip when they are absent. Numbers
// are printed for the validation note (docs/validation/2.4/extai.md).
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { openApp, openFiles, SAMPLES, DIST_DIR } from './helpers.js';

test.describe.configure({ timeout: 240000 });
// WebGPU on; the discrete GPU of this machine unless GW_GPU=integrated (Chrome on Windows ignores powerPreference).
test.use({ launchOptions: { args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu', ...(process.env.GW_GPU === 'integrated' ? [] : ['--force_high_performance_gpu'])] } });

const PACKS = resolve(DIST_DIR, 'packs');
const packFile = (n) => {
  if (!existsSync(PACKS)) return null;
  const f = readdirSync(PACKS).find((x) => (n === 'ai' ? /^ai-\d/.test(x) : x.startsWith(`${n}-`) && !x.slice(n.length + 1).startsWith('text-')));
  return f ? resolve(PACKS, f) : null;
};
const havePacks = (...ns) => ns.every((n) => packFile(n));
const VEGAS = join(SAMPLES, 'msi-spacenet2-wv3', 'SN2_buildings_train_AOI_2_Vegas_PS-RGB_img10.tif');
const VEGAS_TRUTH = join(SAMPLES, 'msi-spacenet2-wv3', 'SN2_buildings_train_AOI_2_Vegas_geojson_buildings_img10.geojson');
const LIBYA = resolve('..', 'TE-corpus', 'eo-maxar-libya-floods-wv3-prepost');
const PRE = join(LIBYA, '2023-08-01', '1040010087AB7E00-visual.tif');
const POST = join(LIBYA, '2023-09-15', '104001008B282A00-visual.tif');
const CATALOG = resolve('fixtures', 'fx24', 'extai', 'mini-ggdm.gwcatalog.json');
const LANDCOVER = 'D:/gwb24/data-extai/sparsemask/onnx/model.onnx';
const QUIET = { prefs: { welcomeDone: true } };
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function withImage(page, packs, image, opts = QUIET) {
  const { frame, logs } = await openApp(page, 'file', opts);
  if (packs.length) {
    await openFiles(frame, packs.map((n) => packFile(n)));
    await frame.waitForFunction((n) => n.every((x) => window.gisworkbench.packs.loaded.has(x)), packs, { timeout: 300000 });
  }
  if (image) {
    const imgs = Array.isArray(image) ? image : [image];
    await openFiles(frame, imgs);
    await frame.waitForFunction((k) => [...window.gisworkbench.layers.values()].filter((l) => l.stats && l.lutTex).length >= k, imgs.length, { timeout: 180000 });
  }
  return { frame, logs };
}
async function axe(frame, sel) {
  await frame.evaluate(AXE);
  return frame.evaluate(async ([s, tags]) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: tags } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), [sel, AXE_TAGS]);
}
/** Click a dialog's button by its label. */
const press = (frame, id, label) => frame.locator(`[data-id="dialog:${id}"] .dlg-buttons button`, { hasText: label }).click();

// ---------------------------------------------------------------- REQ-GAP-01

test('REQ-GAP-01 API v2: tools with parameters and no dialog, events, MCP mapping, v1 unchanged', async ({ page }) => {
  test.setTimeout(1200000);
  const { frame, logs } = await withImage(page, [], VEGAS);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const v2 = app.api.v2;
    const ev = [];
    v2.on('*', (e) => ev.push(e.type));
    const dialogs = () => document.querySelectorAll('.dlg').length;
    const out = { dialogsBefore: dialogs() };
    out.version = await v2.api.version();
    out.v1 = app.api.version();
    out.v1help = app.api.help();
    out.layers = await v2.layers.list();
    const l = out.layers[0];
    out.gp = await v2.geo.groundPoint({ x: 300, y: 300 });
    out.ip = await v2.geo.imagePoint({ lat: out.gp.lat, lon: out.gp.lon, h: out.gp.h });
    const g2 = await v2.geo.groundPoint({ x: 600, y: 300 });
    out.dist = await v2.measure.distance({ points: [[out.gp.lon, out.gp.lat], [g2.lon, g2.lat]] });
    out.distCore = app.core.inverse(out.gp.lat, out.gp.lon, g2.lat, g2.lon).distance;
    out.area = await v2.measure.area({ ring: [[out.gp.lon, out.gp.lat], [g2.lon, g2.lat], [g2.lon, g2.lat + 0.001]] });
    out.view = await v2.view.set({ cx: 200, cy: 210, zoom: 1.5 });
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    // Extraction on a catalogue layer, attributes checked by the catalogue.
    const layer = await v2.extract.newSchemaLayer({ code: 'AL013' });
    const ring = [[300, 300], [360, 300], [360, 350], [300, 350]].map(([x, y]) => app.layers.get(l.id).groundAt(x, y));
    out.feat = await v2.extract.createFeature({ type: 'Polygon', coordinates: ring.map((g) => [g.lon, g.lat]), layer, square: true, attrs: { FFN: 850 } });
    try {
      await v2.extract.setAttributes({ feature: out.feat.feature, attrs: { FFN: 12345 } });
    } catch (e) {
      out.badAttr = { code: e.code, message: e.message };
    }
    out.features = await v2.vectors.features({ layer });
    out.geojson = await v2.vectors.export({ layer, format: 'geojson' });
    await v2.selection.set({ ids: [out.feat.feature] });
    await Promise.resolve();
    out.sel = await v2.selection.get();
    const gid = await v2.graphics.create({ shape: 'marker', coordinates: [[out.gp.lon, out.gp.lat]], text: 'API' });
    out.graphics = (await v2.graphics.list()).length;
    out.deleted = await v2.graphics.delete({ ids: [gid] });
    out.chip = await v2.products.chip({ width: 400, height: 300 });
    out.report = await v2.products.report({ format: 'html' });
    out.cog = await v2.products.cog({});
    out.cmds = (await v2.commands.list({ filter: 'lai.' })).map((c) => c.id);
    out.jobs = await v2.jobs.list({ limit: 5 });
    out.dialogsAfter = dialogs();
    // Console line and MCP.
    out.console = await app.api.runLine('geo.parse {"text": "36SXA1234567890"}').catch((e) => e.message);
    const tools = app.mcp.listTools();
    out.mcpV2 = tools.filter((x) => x.name.startsWith('gw2_')).length;
    out.mcpV1 = tools.filter((x) => x.name.startsWith('gw_')).length;
    const call = await app.mcp.callTool('gw2_layers_list', {});
    out.mcpLayers = JSON.parse(call.result.content[0].text).length;
    const prop = await app.mcp.callTool('gw2_graphics_create', { coordinates: [[out.gp.lon, out.gp.lat]] });
    out.mcpProposal = prop.result.structuredContent?.status;
    out.events = [...new Set(ev)];
    out.recent = (await v2.events.recent({ types: ['view'] })).length;
    return out;
  });
  console.log(`API v2 ${r.version.api}: ${r.mcpV2} gw2_* MCP tools beside ${r.mcpV1} gw_* tools; events ${r.events.join(', ')}`);
  expect(r.version).toMatchObject({ api: '3.0.0', major: 3, v1: 1 });
  expect(r.v1.api).toBe(1);
  expect(r.v1help).toEqual(['createGraphic', 'exportChip', 'groundPoint', 'help', 'imagePoint', 'layers', 'openImage', 'runCommand', 'runLine', 'setChain', 'version', 'view']);
  expect(r.layers).toHaveLength(1);
  expect(Math.abs(r.ip.x - 300) + Math.abs(r.ip.y - 300)).toBeLessThan(0.05);
  expect(Math.abs(r.dist.metres - r.distCore)).toBeLessThan(1e-6);
  expect(r.area.squareMetres).toBeGreaterThan(0);
  expect(r.view).toMatchObject({ cx: 200, cy: 210, zoom: 1.5 });
  expect(r.feat.issues).toEqual([]);
  expect(r.badAttr.message).toMatch(/12345 is not an allowed value/);
  expect(r.features.total).toBe(1);
  expect(r.features.features[0].properties.FFN).toBe(850);
  expect(JSON.parse(r.geojson.text).features).toHaveLength(1);
  expect(r.sel).toEqual([{ id: r.feat.feature, type: 'feature', layer: r.feat.layer }]);
  expect(r.graphics).toBeGreaterThanOrEqual(1);
  expect(r.deleted).toBe(1);
  expect(r.chip.file.type).toBe('image/png');
  expect(r.chip.file.size).toBeGreaterThan(10000);
  expect(r.report.text).toMatch(/<html/i);
  expect(r.cog).toMatchObject({ type: 'image/tiff', name: expect.stringMatching(/_cog.tif$/) });
  expect(r.cog.size).toBeGreaterThan(100000);
  expect(r.cmds).toEqual(expect.arrayContaining(['lai.findscene', 'lai.describe', 'lai.changemask', 'lai.models', 'lai.landcover']));
  expect(r.dialogsBefore).toBe(0);
  expect(r.dialogsAfter).toBe(0);
  expect(r.console).toMatchObject({ format: expect.stringMatching(/MGRS/i) });
  expect(r.mcpV2).toBeGreaterThanOrEqual(65);
  expect(r.mcpV1).toBeGreaterThanOrEqual(20);
  expect(r.mcpLayers).toBe(1);
  expect(r.mcpProposal).toBe('pending');
  expect(r.events).toEqual(expect.arrayContaining(['layer', 'selection', 'view', 'job']));
  expect(r.recent).toBeGreaterThan(0);
  expect(logs).toEqual([]);
});

test('REQ-GAP-01 headless recipe runner: gates stop and resume, files returned, no dialog', async ({ page }) => {
  const { frame, logs } = await withImage(page, [], VEGAS);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const v2 = app.api.v2;
    const recipe = { format: 'gw-recipe/1', id: 'api-test', name: 'API test', steps: [{ id: 'c', op: 'contrast' }, { id: 'g', op: 'gate' }, { id: 'e', op: 'exportGeojson', params: { what: 'accepted-detections' } }] };
    const ops = await v2.recipes.ops();
    const a = await v2.recipes.run({ recipe, gates: 'stop' });
    const waitingDialogs = document.querySelectorAll('.dlg').length;
    const b = await v2.recipes.resume({ run: a.run });
    const c = await v2.recipes.run({ recipe, gates: 'fail' });
    const d = await v2.recipes.run({ recipe, gates: 'continue' });
    const one = await v2.recipes.op({ op: 'contrast', params: {} });
    // A recipe with a layer to export: accepted detections become a GeoJSON file in the result.
    await v2.detections.add({ detections: [{ cls: 'car', confidence: 0.9, box: [10, 10, 30, 30] }] });
    const det = (await v2.detections.list())[0];
    await v2.detections.setStatus({ ids: [det.id], status: 'accepted' });
    const e = await v2.recipes.run({ recipe: { ...recipe, steps: [recipe.steps[2]] } });
    return { ops: ops.map((o) => o.op), a, b, c, d, one, e, waitingDialogs, dialogs: document.querySelectorAll('.dlg').length };
  });
  expect(r.ops).toEqual(expect.arrayContaining(['contrast', 'find', 'search', 'align', 'outline', 'gate', 'chips', 'exportDeck', 'exportGeojson', 'convertFolder', 'command']));
  expect(r.a.state).toBe('waiting');
  expect(r.a.steps.map((s) => s.status)).toEqual(['done', 'waiting', 'pending']);
  expect(r.b.state).toBe('done');
  expect(r.b.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
  expect(r.c.state).toBe('stopped');
  expect(r.c.error).toMatch(/gate .* reached/);
  expect(r.d).toMatchObject({ state: 'done', ok: true });
  expect(r.one.summary).toMatch(/CLAHE clip/);
  expect(r.e.files).toHaveLength(1);
  expect(r.e.files[0].name).toBe('accepted-detections.geojson');
  expect(JSON.parse(r.e.files[0].text).features).toHaveLength(1);
  expect(r.waitingDialogs).toBe(0);
  expect(r.dialogs).toBe(0);
  expect(logs).toEqual([]);
});

// ---------------------------------------------------------------- REQ-GAP-52/53

test('REQ-GAP-52 import a feature catalogue from the UI; kept in the project and the settings', async ({ page }) => {
  const { frame, logs } = await withImage(page, [], VEGAS);
  // The File System Access picker needs a user gesture; the app's fallback file input is used here.
  await frame.evaluate(() => (window.gisworkbench.runMode.caps.fsaPicker = false));
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), frame.evaluate(() => void window.gisworkbench.commands.run('ext.importcatalog'))]);
  await fc.setFiles(CATALOG);
  await expect(frame.locator('[data-id="dialog:catalog-import"]')).toBeVisible();
  await expect(frame.locator('[data-id="dialog:catalog-import"]')).toContainText('Mini GGDM-like catalogue');
  expect(await axe(frame, '[data-id="dialog:catalog-import"]')).toEqual([]);
  await press(frame, 'catalog-import', 'Import');
  await frame.waitForFunction(() => window.gisworkbench.catalogs.info('test-ggdm-mini')?.kept.length === 2);
  // New Layer from Schema offers it, with subtypes.
  await frame.evaluate(() => void window.gisworkbench.commands.run('ext.newschema'));
  await expect(frame.locator('[data-id="dialog:ext-newschema"]')).toBeVisible();
  await frame.locator('[data-id="ext-newschema:catalog"]').selectOption('test-ggdm-mini');
  await frame.locator('[data-id="ext-newschema:class"]').selectOption('AQ040');
  await expect(frame.locator('[data-id="ext-newschema:subtype"] option')).toHaveCount(3);
  await frame.locator('[data-id="ext-newschema:subtype"]').selectOption('AQ041');
  expect(await axe(frame, '[data-id="dialog:ext-newschema"]')).toEqual([]);
  await press(frame, 'ext-newschema', 'OK');
  const lay = await frame.evaluate(() => {
    const v = window.gisworkbench.store.all('vlayer').at(-1);
    return { schema: v.schema, fields: v.fields.map((f) => f.name), defaults: v.defaults };
  });
  expect(lay.schema).toMatchObject({ catalog: 'test-ggdm-mini', code: 'AQ040', subtype: 'AQ041' });
  expect(lay.defaults).toEqual({ RLE: 1, F_CODE: 'AQ041' });
  // The catalogues dialog lists it and passes axe.
  await frame.evaluate(() => void window.gisworkbench.commands.run('ext.catalogs'));
  await expect(frame.locator('[data-id="dialog:catalogs"]')).toContainText('Mini GGDM-like catalogue');
  expect(await axe(frame, '[data-id="dialog:catalogs"]')).toEqual([]);
  await press(frame, 'catalogs', 'Close');
  // Kept in the project: the record is in the saved records and comes back on open.
  const proj = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const snap = app.store.snapshot();
    const rec = snap.find((r) => r.type === 'catalog');
    // Forget the settings copy, then reopen the project's records: the catalogue returns from the project.
    await app.catalogs.forget('test-ggdm-mini');
    const gone = !app.attribution.catalog('test-ggdm-mini');
    app.store.load(snap);
    return { rec: !!rec, gone, back: app.catalogs.info('test-ggdm-mini') };
  });
  expect(proj).toMatchObject({ rec: true, gone: true, back: { id: 'test-ggdm-mini', kept: ['project'], source: 'user', types: 2 } });
  // Kept in the settings: import again (settings only), reload, it is there with no project.
  await frame.evaluate(async (text) => window.gisworkbench.catalogs.import(text, { keep: 'settings' }), readFileSync(CATALOG, 'utf8'));
  await page.reload();
  const f2 = page.frames()[0];
  await f2.waitForFunction(() => window.gisworkbench?._ready);
  await f2.evaluate(() => window.gisworkbench.catalogs.restored);
  const after = await f2.evaluate(() => window.gisworkbench.catalogs.info('test-ggdm-mini'));
  expect(after).toMatchObject({ id: 'test-ggdm-mini', kept: ['settings'] });
  expect(logs.filter((x) => !/Failed to load resource/.test(x))).toEqual([]);
});

test('REQ-GAP-53 contingent domains in the attribute form; rules in validation; catalogues from a data pack', async ({ page }) => {
  const { frame, logs } = await withImage(page, [], VEGAS);
  await frame.evaluate((text) => window.gisworkbench.catalogs.import(text, { keep: 'project' }), readFileSync(CATALOG, 'utf8'));
  const ids = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const v2 = app.api.v2;
    const layer = await v2.extract.newSchemaLayer({ code: 'AL013', catalog: 'test-ggdm-mini' });
    const l = [...app.layers.values()][0];
    const ring = [[300, 300], [360, 300], [360, 350], [300, 350]].map(([x, y]) => l.groundAt(x, y));
    const f = await v2.extract.createFeature({ type: 'Polygon', coordinates: ring.map((g) => [g.lon, g.lat]), layer });
    return { layer, feature: f.feature };
  });
  // The form narrows BUI once FFN is Education.
  await frame.evaluate((id) => void window.gisworkbench.attribution.openForm(id), ids.feature);
  const form = frame.locator('[data-id="dialog:attr-form"]');
  await expect(form).toBeVisible();
  const sel = (label) => form.locator(`select[aria-label="${label}"]`);
  expect(await sel('Building Use Index').locator('option').count()).toBe(7);
  await sel('Feature Function').selectOption('850');
  await expect(sel('Building Use Index').locator('option')).toHaveCount(3);
  expect(await sel('Building Use Index').locator('option').evaluateAll((o) => o.map((x) => x.value).sort())).toEqual(['-999999', '1', '2']);
  expect(await axe(frame, '[data-id="dialog:attr-form"]')).toEqual([]);
  await sel('Building Use Index').selectOption('2');
  // HGT must be 3–300 m for a university: the form says so and stays open.
  await form.locator('input[aria-label="Height"]').fill('1');
  await press(frame, 'attr-form', 'OK');
  await expect(form.locator('.err')).toContainText('outside 3 to 300');
  await form.locator('input[aria-label="Height"]').fill('25');
  await press(frame, 'attr-form', 'OK');
  await expect(form).toBeHidden();
  const v = await frame.evaluate(async (ids) => {
    const v2 = window.gisworkbench.api.v2;
    const ok = await v2.extract.validate({ layer: ids.layer });
    let refused = null;
    try {
      await v2.extract.setAttributes({ feature: ids.feature, attrs: { BUI: 3 } });
    } catch (e) {
      refused = { code: e.code, message: e.message };
    }
    await v2.extract.setAttributes({ feature: ids.feature, attrs: { FFN: 931, BUI: '-999999' } });
    const named = await v2.extract.validate({ layer: ids.layer });
    return { ok, refused, named };
  }, ids);
  expect(v.ok).toEqual([]);
  expect(v.refused).toMatchObject({ code: 'E_RULE_DOMAIN' });
  expect(v.refused.message).toMatch(/3 is not allowed here \(education buildings are schools or universities\)/);
  expect(v.named.map((x) => `${x.field}:${x.code}`)).toEqual(['ZI005_FNA:E_RULE_REQUIRED']);
  // A data pack with a catalogue entry (a data-only pack is accepted with its own hashes).
  const cat = { ...JSON.parse(readFileSync(CATALOG, 'utf8')), id: 'pack-ggdm-mini', name: 'Pack catalogue' };
  const bytes = strToU8(JSON.stringify(cat));
  const pj = { format: 'gw-pack/1', name: 'cat-test', title: 'Test catalogue pack', version: '1', minTool: '2.0.0', description: 'test', licence: 'Apache-2.0', entries: [{ path: 'catalog/test.gwcatalog.json', kind: 'data', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  const zip = zipSync({ 'pack.json': strToU8(JSON.stringify(pj)), 'catalog/test.gwcatalog.json': bytes });
  const src = await frame.evaluate(async (b64) => {
    const app = window.gisworkbench;
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await app.openPackFiles([new File([bin], 'cat-test-1.gwpack')]);
    return app.catalogs.info('pack-ggdm-mini');
  }, Buffer.from(zip).toString('base64'));
  expect(src).toMatchObject({ source: 'pack', types: 2 });
  expect(logs).toEqual([]);
});

// ---------------------------------------------------------------- REQ-GAP-56 (WebGPU, the discrete GPU)

test.describe('REQ-GAP-56 WebGPU fp16', () => {
  test('SAM 2.1 fp16 encoder timing per 1024² tile on this machine, and the fp16 outlines on Vegas', async ({ page }) => {
  test.setTimeout(1200000);
    test.skip(!havePacks('ai', 'ai-sam2', 'ai-gpu'), 'needs the ai, ai-sam2 and ai-gpu packs of this build');
    const truth = JSON.parse(readFileSync(VEGAS_TRUTH, 'utf8')).features.filter((f) => f.geometry?.type === 'Polygon');
    const { frame } = await withImage(page, ['ai', 'ai-sam2', 'ai-gpu'], VEGAS);
    const r = await frame.evaluate(async (polys) => {
      const app = window.gisworkbench;
      const b = await app.aiLocal.benchmarkSam({ runs: 12 });
      const l = [...app.layers.values()][0];
      const rings = polys.map((p) => p.coordinates[0].map(([lon, lat]) => l.imageAt(lat, lon)).map((q) => [q.x, q.y]));
      const area = (r) => Math.abs(r.reduce((s, p, i) => s + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2);
      const inside = (poly, x, y) => {
        let c = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (poly[i][1] > y !== poly[j][1] > y && x < ((poly[j][0] - poly[i][0]) * (y - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
        return c;
      };
      const iouOf = (a, q) => {
        const xs = [...a, ...q].map((p) => p[0]);
        const ys = [...a, ...q].map((p) => p[1]);
        let inter = 0;
        let uni = 0;
        for (let y = Math.floor(Math.min(...ys)); y < Math.max(...ys); y++)
          for (let x = Math.floor(Math.min(...xs)); x < Math.max(...xs); x++) {
            const p = inside(a, x + 0.5, y + 0.5);
            const s = inside(q, x + 0.5, y + 0.5);
            if (p && s) inter++;
            if (p || s) uni++;
          }
        return inter / uni;
      };
      const ious = [];
      for (const ring of rings.sort((x, y) => area(y) - area(x)).slice(0, 10)) {
        const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
        const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
        const s = await app.sam.select(l, cx, cy, { square: true });
        ious.push(iouOf(s.polygon, ring));
      }
      const sorted = [...ious].sort((x, y) => x - y);
      const m = await app.aiLocal.load('sam2');
      return { ...b, ious, median: (sorted[4] + sorted[5]) / 2, title: m.title };
    }, truth.map((f) => f.geometry));
    console.log(`SAM 2.1 encoder ${r.precision} on ${r.device} (${r.adapter?.vendor} ${r.adapter?.architecture}): first ${r.first} ms, warm median ${r.warmMedian} ms, all ${r.times.join(', ')}; outlines IoU median ${r.median.toFixed(3)} (${r.ious.map((x) => x.toFixed(2)).join(', ')})`);
    expect(r.device).toBe('webgpu');
    expect(r.precision).toBe('fp16');
    expect(r.title).toMatch(/fp16 encoder/);
    expect(r.median).toBeGreaterThan(0.6);
    if (process.env.GW_GPU !== 'integrated') expect(r.warmMedian).toBeLessThanOrEqual(300);
  });

  test('open-vocabulary detection over a whole scene as a job, with cancel', async ({ page }) => {
  test.setTimeout(1200000);
    test.skip(!havePacks('ai', 'ai-detect', 'ai-gpu'), 'needs the ai, ai-detect and ai-gpu packs of this build');
    const truth = JSON.parse(readFileSync(VEGAS_TRUTH, 'utf8')).features.filter((f) => f.geometry?.type === 'Polygon');
    const image = existsSync(POST) ? POST : VEGAS;
    const { frame } = await withImage(page, ['ai', 'ai-detect', 'ai-gpu'], [VEGAS, ...(image !== VEGAS ? [image] : [])]);
    const r = await frame.evaluate(async ([polys, big]) => {
      const app = window.gisworkbench;
      const ls = [...app.layers.values()];
      const vegas = ls[0];
      const ev = [];
      app.api.v2.on('job', (e) => e.op === 'ai-task' && ev.push(e.state));
      // Accuracy on Vegas: every building box against the SpaceNet footprints (box IoU ≥ 0.3).
      const a = await app.api.v2.ai.find({ objects: ['building'], scope: 'scene', layer: vegas.id, threshold: 0.12 });
      const tb = polys.map((p) => {
        const q = p.coordinates[0].map(([lon, lat]) => vegas.imageAt(lat, lon));
        return [Math.min(...q.map((v) => v.x)), Math.min(...q.map((v) => v.y)), Math.max(...q.map((v) => v.x)), Math.max(...q.map((v) => v.y))];
      });
      const dets = app.store.all('detection').filter((d) => d.layer === vegas.id).map((d) => [d.ring[0][0], d.ring[0][1], d.ring[2][0], d.ring[2][1]]);
      const iou = (p, q) => {
        const w = Math.max(0, Math.min(p[2], q[2]) - Math.max(p[0], q[0]));
        const h = Math.max(0, Math.min(p[3], q[3]) - Math.max(p[1], q[1]));
        const i = w * h;
        return i / ((p[2] - p[0]) * (p[3] - p[1]) + (q[2] - q[0]) * (q[3] - q[1]) - i);
      };
      const hit = dets.filter((d) => tb.some((t) => iou(d, t) >= 0.3)).length;
      const found = tb.filter((t) => dets.some((d) => iou(d, t) >= 0.3)).length;
      const out = { vegas: { ...a, precision: dets.length ? hit / dets.length : 0, recall: found / tb.length, truth: tb.length, dets: dets.length } };
      // A whole large scene as a job, capped to 24 tiles (the step doubles to fit), then a run that is cancelled.
      if (big) {
        const l = ls[1];
        const t0 = performance.now();
        const b = await app.api.v2.ai.find({ objects: ['building', 'vehicle'], scope: 'scene', layer: l.id, threshold: 0.2 });
        out.big = { tiles: b.tiles, step: b.step, ms: b.ms, wall: Math.round(performance.now() - t0), count: b.count, device: b.device, size: [l.width, l.height] };
        const p = app.aiLocal.findScene(['car'], { layer: l, maxTiles: 400, step: 1, commit: false });
        await new Promise((res) => setTimeout(res, 4000));
        const queued = app.aiTasks().length;
        app.aiTasks()[0]?.cancel();
        out.cancel = await p.then(() => 'finished', (e) => (e.cancelled ? 'cancelled' : e.message));
        out.queued = queued;
        out.left = app.aiTasks().length;
      }
      out.events = ev;
      return out;
    }, [truth.map((f) => f.geometry), image !== VEGAS]);
    console.log(`Find objects (scene) on Vegas: ${r.vegas.count} buildings, ${r.vegas.tiles} tile(s), ${r.vegas.ms} ms model time on ${r.vegas.device} (${r.vegas.precision}); precision ${r.vegas.precision?.toFixed?.(3)} recall ${r.vegas.recall.toFixed(3)} vs ${r.vegas.truth} footprints`);
    if (r.big) console.log(`Find objects (scene) on ${r.big.size.join('×')}: ${r.big.tiles} tiles at step ${r.big.step}, ${r.big.count} detections, model ${r.big.ms} ms, wall ${r.big.wall} ms (${Math.round(r.big.wall / r.big.tiles)} ms/tile); cancel → ${r.cancel}`);
    expect(r.vegas.device).toBe('webgpu');
    expect(r.vegas.count).toBeGreaterThan(3);
    expect(r.vegas.scope).toBe('scene');
    expect(r.events).toEqual(expect.arrayContaining(['running', 'done']));
    if (r.big) {
      expect(r.big.tiles).toBeGreaterThan(1);
      expect(r.cancel).toBe('cancelled');
      expect(r.queued).toBe(1);
      expect(r.left).toBe(0);
    }
  });
});

// ---------------------------------------------------------------- REQ-GAP-57

test('REQ-GAP-57 user ONNX model: hash and licence checked, refusals, run on the view; the land-cover pack', async ({ page }) => {
  test.skip(!existsSync(LANDCOVER) || !havePacks('ai'), 'needs the land-cover ONNX file on D: and the ai pack');
  const truth = JSON.parse(readFileSync(VEGAS_TRUTH, 'utf8')).features.filter((f) => f.geometry?.type === 'Polygon');
  const packs = ['ai', ...(havePacks('ai-landcover') ? ['ai-landcover'] : [])];
  const { frame, logs } = await withImage(page, packs, VEGAS);
  const model = readFileSync(LANDCOVER);
  const sha = createHash('sha256').update(model).digest('hex');
  const desc = { format: 'gw-model/1', id: 'my-landcover', name: 'My land cover', task: 'classification', licence: { spdx: ['MIT'], text: 'MIT' }, sha256: sha, input: { size: [1024, 1024], channels: 3, mean: [0.4325, 0.4483, 0.3879], std: [0.0195, 0.0169, 0.0179] }, output: { format: 'logits' }, classes: ['bareland', 'rangeland', 'developed space', 'road', 'tree', 'water', 'agriculture land', 'buildings'] };
  const r = await frame.evaluate(async ([b64, desc, polys]) => {
    const app = window.gisworkbench;
    const v2 = app.api.v2;
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bin], 'model.onnx');
    const refuse = async (d, f = file) => v2.ai.models.add({ descriptor: d, model: f }).then(() => 'accepted', (e) => e.code);
    const out = {};
    out.badHash = await refuse({ ...desc, sha256: '0'.repeat(64) });
    out.gpl = await refuse({ ...desc, licence: { spdx: ['GPL-3.0-only'] } });
    out.yolo = await refuse({ ...desc, name: 'YOLO-World s' });
    out.unknown = await refuse({ ...desc, exec: 'x' });
    const changed = bin.slice();
    changed[1000] ^= 0xff;
    out.tampered = await refuse(desc, new File([changed], 'model.onnx'));
    out.added = await v2.ai.models.add({ descriptor: desc, model: file });
    out.list = (await v2.ai.models.list()).map((m) => `${m.id}:${m.source}`);
    const l = [...app.layers.values()][0];
    app.activePane().fitWhole();
    out.run = await v2.ai.models.run({ model: 'my-landcover', scope: 'scene' });
    // Building-class IoU against the SpaceNet footprints, on the class map layer.
    const P = app.layers.get(out.run.layer);
    const rings = polys.map((p) => p.coordinates[0].map(([lon, lat]) => l.imageAt(lat, lon)).map((q) => [q.x, q.y]));
    const inside = (poly, x, y) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (poly[i][1] > y !== poly[j][1] > y && x < ((poly[j][0] - poly[i][0]) * (y - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
      return c;
    };
    const win = await app.pool.run('window', { handle: P.handle, x0: 0, y0: 0, w: P.width, h: P.height, step: 1, bands: [0] }, { affinity: P.affinity });
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (let y = 0; y < win.h; y++)
      for (let x = 0; x < win.w; x++) {
        const isB = win.planes[0][y * win.w + x] === 8; // class index 7 + 1 (0 is no data)
        const t = rings.some((r) => inside(r, x + 0.5, y + 0.5));
        if (isB && t) tp++;
        else if (isB) fp++;
        else if (t) fn++;
      }
    out.buildingIoU = tp / (tp + fp + fn);
    out.layerSize = [P.width, P.height];
    if (app.aiLocal.hasPack('ai-landcover')) {
      await app.commands.run('lai.landcover');
      out.packRun = app.store.all('layer').filter((x) => /Land cover/.test(x.name)).length;
    }
    return out;
  }, [model.toString('base64'), desc, truth.map((f) => f.geometry)]);
  console.log(`User model: ${JSON.stringify(r.run)}; building IoU ${r.buildingIoU.toFixed(3)} vs SpaceNet footprints`);
  expect(r).toMatchObject({ badHash: 'E_MODEL_HASH', gpl: 'E_MODEL_LICENCE', yolo: 'E_MODEL_LICENCE', unknown: 'E_MODEL_DESCRIPTOR', tampered: 'E_MODEL_HASH' });
  expect(r.added).toMatchObject({ id: 'my-landcover', source: 'user', sha256: sha });
  expect(r.list).toContain('my-landcover:user');
  expect(r.run.task).toBe('classification');
  expect(Object.values(r.run.classes).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  expect(r.buildingIoU).toBeGreaterThan(0.6);
  if (r.packRun !== undefined) expect(r.packRun).toBeGreaterThanOrEqual(1);
  // The models dialog passes axe.
  await frame.evaluate(() => void window.gisworkbench.commands.run('lai.models'));
  await expect(frame.locator('[data-id="dialog:lai-models"]')).toContainText('My land cover');
  expect(await axe(frame, '[data-id="dialog:lai-models"]')).toEqual([]);
  expect(logs.filter((x) => !/VerifyEachNodeIsAssignedToAnEp|onnxruntime/.test(x))).toEqual([]);
});

test('REQ-LAI-04 VLM draft (Moondream2): a labelled proposal with no measurement; a count', async ({ page }) => {
  test.setTimeout(1200000);
  test.skip(!havePacks('ai', 'ai-vlm', 'ai-vlm-text'), 'needs the ai, ai-vlm and ai-vlm-text packs of this build');
  const { frame } = await withImage(page, ['ai', 'ai-vlm', 'ai-vlm-text'], VEGAS);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const v2 = app.api.v2;
    const a = await v2.ai.describe({ question: 'Describe this aerial image. How long is the longest road?' });
    const b = await v2.ai.describe({ count: 'swimming pools' });
    const prop = app.proposals.items.find((p) => p.id === a.proposal);
    app.proposals.accept(a.proposal);
    const obs = app.store.all('observation').at(-1);
    return { a, b, title: prop?.title, prov: prop?.provenance, obs: { text: obs.text, label: obs.label, ai: obs.ai } };
  });
  console.log(`Moondream2 draft (${r.a.device}/${r.a.decoderDevice}): "${r.a.text}" — ${r.a.tokens} tokens, vision ${r.a.msParts.vision} ms, prefill ${r.a.msParts.prefill} ms, decode ${r.a.msParts.decode} ms (${r.a.tokensPerSecond} tok/s); removed ${JSON.stringify(r.a.removedMeasurements)}; count "${r.b.raw}" → ${r.b.count}`);
  expect(r.a.draft).toBe(true);
  expect(r.a.text.length).toBeGreaterThan(10);
  expect(r.a.text).not.toMatch(/\b\d[\d,.]*\s?(m|km|ft|feet|meters|metres)\b/i);
  expect(r.obs.label).toBe('AI-drafted');
  expect(r.obs.ai.model).toMatch(/Moondream2/);
  expect(r.prov).toMatchObject({ kind: 'ai', source: 'local VLM' });
  expect(r.b.count === null || Number.isInteger(r.b.count)).toBe(true);
});

test('REQ-LAI-05 change mask after Auto Align (AI) on the Libya pre/post pair', async ({ page }) => {
  test.setTimeout(1200000);
  test.skip(!existsSync(PRE) || !existsSync(POST) || !havePacks('ai', 'ai-match'), 'needs the Libya pair and the ai-match pack');
  const { frame } = await withImage(page, ['ai', 'ai-match'], [PRE, POST]);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const al = await app.api.v2.ai.align({});
    const cm = await app.api.v2.ai.changeMask({ threshold: 3, polygons: true });
    const ch = app.store.all('change').filter((c) => c.method?.kind === 'change-mask');
    return { rms: al.rmsPx ?? al.rms ?? null, used: al.used ?? null, cm, changes: ch.length, first: ch[0] };
  });
  console.log(`Change mask (Libya): ${r.cm.regions} regions, ${(r.cm.changedFraction * 100).toFixed(2)} % changed of a ${r.cm.mask.width}×${r.cm.mask.height} grid (step ${r.cm.mask.step}), gain ${r.cm.gain.toFixed(3)}, sigma ${r.cm.sigma.toFixed(2)}`);
  expect(r.cm.regions).toBeGreaterThan(0);
  expect(r.changes).toBe(r.cm.regions);
  expect(r.cm.layer).toBeTruthy();
  expect(r.first.status).toBe('candidate');
  // The dialog passes axe.
  await frame.evaluate(() => void window.gisworkbench.commands.run('lai.changemask'));
  await expect(frame.locator('[data-id="dialog:lai-changemask"]')).toBeVisible();
  expect(await axe(frame, '[data-id="dialog:lai-changemask"]')).toEqual([]);
});

test('REQ-GAP-56/57 the new AI dialogs pass axe', async ({ page }) => {
  const { frame } = await withImage(page, [], VEGAS);
  for (const [cmd, id] of [['lai.findscene', 'lai-findscene'], ['lai.describe', 'lai-describe'], ['lai.models', 'lai-models']]) {
    await frame.evaluate((c) => void window.gisworkbench.commands.run(c), cmd);
    await expect(frame.locator(`[data-id="dialog:${id}"]`)).toBeVisible();
    expect(await axe(frame, `[data-id="dialog:${id}"]`), id).toEqual([]);
    await frame.evaluate((i) => document.querySelector(`[data-id="dialog:${i}"]`)?.finish?.(null), id);
  }
});
