// REG-097 the catalogue-osm pack in the built file: opened from Data Packs, its catalogue is
// offered by New Layer from Schema, and a layer of a preset's subtype fills its tags in on every
// new feature. Needs the pack of this build (node build/packs.mjs --fetch before the build).
import { test, expect } from '@playwright/test';
import { openApp, packPath } from './helpers.js';

test('REG-097 the catalogue-osm pack gives New Layer from Schema the OSM presets, tags filled in', async ({ page }) => {
  test.setTimeout(180000);
  const pack = packPath('catalogue-osm');
  const { frame, logs } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  const input = await frame.evaluateHandle(() => Object.assign(document.body.appendChild(document.createElement('input')), { type: 'file', hidden: true }));
  await input.asElement().setInputFiles(pack);
  const info = await frame.evaluate(async (i) => {
    const app = window.gisworkbench;
    await app.openPackFiles([...i.files]);
    return app.catalogs.info('osm-id-presets');
  }, input);
  expect(info).toMatchObject({ source: 'pack', version: '7.3.0' });
  expect(info.types).toBeGreaterThan(1000);

  await frame.evaluate(() => void window.gisworkbench.commands.run('ext.newschema'));
  const dlg = frame.locator('[data-id="dialog:ext-newschema"]');
  await expect(dlg).toBeVisible();
  await frame.locator('[data-id="ext-newschema:catalog"]').selectOption('osm-id-presets');
  await frame.locator('[data-id="ext-newschema:class"]').selectOption('amenity/cafe');
  await expect(frame.locator('[data-id="ext-newschema:class"] option[value="amenity/cafe"]')).toHaveText('amenity/cafe Cafe (Point/Polygon)');
  await frame.locator('[data-id="ext-newschema:subtype"]').selectOption('amenity/cafe');
  await dlg.getByRole('button', { name: 'OK' }).click();
  await expect(dlg).toBeHidden();

  const out = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const v = app.store.all('vlayer').at(-1);
    const f = app.commitFeature(app.activePane(), 'Point', [{ lon: 13.405, lat: 52.52, h: 0 }]);
    return { schema: v.schema, fields: v.fields.map((x) => x.name), amenity: app.store.get(f.id ?? f)?.attrs?.amenity ?? f.attrs?.amenity };
  });
  expect(out.schema).toMatchObject({ catalog: 'osm-id-presets', code: 'amenity/cafe', subtype: 'amenity/cafe' });
  // OSM's name tag is name_attr: name is a feature column of its own (the importer's rule).
  expect(out.fields).toEqual(expect.arrayContaining(['amenity', 'name_attr', 'cuisine']));
  expect(out.amenity).toBe('cafe');
  expect(logs.filter((x) => !/Failed to load resource/.test(x))).toEqual([]);
});
