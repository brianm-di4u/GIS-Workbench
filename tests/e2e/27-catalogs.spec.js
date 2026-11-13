// SCN-79 REQ-GAP-87 civil feature catalogues in the built file: an INSPIRE application schema with
// its code list imported through Import Feature Catalogue, a layer of one of its feature types
// captured, and the layer through a GeoPackage with the Schema extension and back, domains kept.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { openApp } from './helpers.js';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
async function axe(frame, sel) {
  await frame.evaluate(AXE);
  return frame.evaluate(async ([s, tags]) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: tags } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), [sel, AXE_TAGS]);
}

test('SCN-79 REQ-GAP-87 an INSPIRE schema imported, a layer captured against it, through GeoPackage and back', async ({ page }) => {
  test.setTimeout(180000);
  const { frame, logs } = await openApp(page, 'file');
  // The File System Access picker needs a user gesture; the app's fallback file input is used here.
  await frame.evaluate(() => (window.gisworkbench.runMode.caps.fsaPicker = false));
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), frame.evaluate(() => void window.gisworkbench.commands.run('ext.importcatalog'))]);
  await fc.setFiles([resolve('fixtures/catalogs/inspire-roads.xsd'), resolve('fixtures/catalogs/inspire-surfacecomposition.xml')]);
  const dlg = frame.locator('[data-id="dialog:catalog-import"]');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('2 feature types');
  expect(await axe(frame, '[data-id="dialog:catalog-import"]')).toEqual([]);
  await dlg.getByRole('button', { name: 'Import' }).click();
  await frame.waitForFunction(() => window.gisworkbench.catalogs.list().some((c) => c.source === 'user'));
  const catId = await frame.evaluate(() => window.gisworkbench.catalogs.list().find((c) => c.source === 'user').id);

  // New Layer from Schema offers it.
  await frame.evaluate(() => void window.gisworkbench.commands.run('ext.newschema'));
  await expect(frame.locator('[data-id="dialog:ext-newschema"]')).toBeVisible();
  await frame.locator('[data-id="ext-newschema:catalog"]').selectOption(catId);
  await frame.locator('[data-id="ext-newschema:class"]').selectOption('RoadLink');
  await frame.locator('[data-id="dialog:ext-newschema"]').getByRole('button', { name: 'OK' }).click();

  const out = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const v = app.store.all('vlayer').at(-1);
    const p = app.activePane();
    const f = app.commitFeature(p, 'LineString', [{ lon: -104.99, lat: 39.74, h: 0 }, { lon: -104.98, lat: 39.745, h: 0 }]);
    app.attribution.setAttr(f, 'surfaceComposition', 'gravel');
    app.attribution.setAttr(f, 'numberOfLanes', 2);
    // A value outside the code list is refused.
    let refused = false;
    try {
      app.attribution.setAttr(f, 'surfaceComposition', 'cobbles');
    } catch {
      refused = true;
    }
    const issues = app.attribution.attributeIssues?.(v.id) ?? null;
    const { bytes } = await app.attribution.gpkgBytes([v.id]);
    const ids = await app.attribution.openGpkgBytes(bytes, 'roads.gpkg');
    const back = app.store.get(ids[0]?.id ?? ids[0]);
    const cat = app.attribution.catalog(back.schema?.catalog);
    const feat = app.store.all('feature').find((x) => x.vlayer === back.id);
    return { schema: v.schema, fields: v.fields.map((x) => x.name), refused, issues: issues?.length ?? null, backFields: back.fields.map((x) => x.name), backSchema: back.schema, domain: cat?.attributes?.surfaceComposition?.domain ?? null, attrs: feat?.attrs };
  });
  expect(out.schema).toMatchObject({ catalog: catId, code: 'RoadLink' });
  expect(out.fields).toEqual(expect.arrayContaining(['surfaceComposition', 'numberOfLanes', 'localRoadCode']));
  expect(out.refused).toBe(true);
  expect(out.backFields).toEqual(expect.arrayContaining(['surfaceComposition', 'numberOfLanes', 'localRoadCode']));
  expect(out.backSchema?.code).toBeTruthy();
  expect(Object.keys(out.domain ?? {})).toEqual(expect.arrayContaining(['asphalt', 'gravel', 'concrete']));
  expect(out.attrs).toMatchObject({ surfaceComposition: 'gravel', numberOfLanes: 2 });
  // The form offers an empty choice for a coded value whose null is empty, so a code can be taken back.
  const fid = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const f = app.store.all('feature').find((x) => x.attrs?.surfaceComposition === 'gravel');
    void app.attribution.openForm(f.id);
    return f.id;
  });
  const form = frame.locator('[data-id="dialog:attr-form"]');
  await expect(form).toBeVisible();
  const coded = form.locator('select[aria-label="surfaceComposition"]');
  expect(await coded.locator('option').evaluateAll((o) => o[0].value)).toBe('');
  await expect(coded).toHaveValue('gravel');
  await coded.selectOption('');
  await form.getByRole('button', { name: 'OK' }).click();
  await expect(form).toBeHidden();
  expect(await frame.evaluate((id) => window.gisworkbench.store.get(id).attrs.surfaceComposition ?? '', fid)).toBe('');
  expect(logs.filter((x) => !/Failed to load resource/.test(x))).toEqual([]);
});
