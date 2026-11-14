// REG-097 the catalogue-osm pack in the built file: opened from Data Packs, its catalogue is
// offered by New Layer from Schema, and a layer of a preset's subtype has its columns as decision
// 0019 has them and fills its tags in on every new feature. Needs the pack of this build
// (node build/packs.mjs --fetch before the build).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { openApp, packPath } from './helpers.js';

test('REG-097 the catalogue-osm pack gives New Layer from Schema the OSM presets, columns per decision 0019, tags filled in', async ({ page }) => {
  test.setTimeout(180000);
  const pack = packPath('catalogue-osm');
  // The whole catalogue, as decision 0019 has it: no type writes a column twice, every definition is
  // used, and a fixed tag sits on its key's main definition, not a second one.
  const cat = JSON.parse(strFromU8(unzipSync(readFileSync(pack))['osm.gwcatalog.json']));
  const used = new Set(cat.types.flatMap((ty) => ty.attributes));
  const columnOf = (k) => cat.attributes[k].field ?? k;
  expect(cat.types.filter((ty) => new Set(ty.attributes.map(columnOf)).size !== ty.attributes.length).map((ty) => ty.code)).toEqual([]);
  expect(Object.keys(cat.attributes).filter((k) => !used.has(k))).toEqual([]);
  // No column is a key that stands for many tags (addr, payment:, addr:*).
  expect(Object.keys(cat.attributes).map(columnOf).filter((c) => c === 'addr' || c.endsWith(':') || c.includes('*'))).toEqual([]);
  expect(cat.types.flatMap((ty) => Object.keys(ty.subtypes[0].fixed).filter((k) => cat.attributes[k].field).map((k) => `${ty.code} ${k}`))).toEqual([]);
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
  await frame.locator('[data-id="ext-newschema:class"]').selectOption('highway/mini_roundabout');
  await frame.locator('[data-id="ext-newschema:subtype"]').selectOption('highway/mini_roundabout');
  await dlg.getByRole('button', { name: 'OK' }).click();
  await expect(dlg).toBeHidden();

  // Decision 0019 on the real presets: a mini roundabout's direction is direction_clock's
  // clockwise/anticlockwise, written to the direction column, where most presets have a number.
  const out = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const v = app.store.all('vlayer').at(-1);
    const f = app.commitFeature(app.activePane(), 'Point', [{ lon: 13.405, lat: 52.52, h: 0 }]);
    return { schema: v.schema, direction: v.fields.find((x) => x.name === 'direction'), highway: app.store.get(f).attrs.highway };
  });
  expect(out.schema).toMatchObject({ catalog: 'osm-id-presets', code: 'highway/mini_roundabout' });
  expect(Object.keys(out.direction.domain ?? {}).sort()).toEqual(['anticlockwise', 'clockwise']);
  expect(out.highway).toBe('mini_roundabout');
  expect(logs.filter((x) => !/Failed to load resource/.test(x))).toEqual([]);
});
