// REG-027 (#54) on the built file: the LAS reader's height warnings name the geoid in use. With the
// EGM2008 2.5′ pack loaded, a NAVD88 LAS says it is converted with EGM2008 2.5′ (not EGM96), and an
// EGM96 LAZ says its heights are converted with a different geoid. Without the pack, EGM96 as before.
import { test, expect } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openApp, openFiles, DIST_DIR } from './helpers.js';

const FX09 = (n) => resolve('fixtures/fx09', n);
const PACKS = join(DIST_DIR, 'packs');
// The pack from this build, else GW_GEOID_PACK (a geoid-egm2008-25 .gwpack from another build).
const PACK = (existsSync(PACKS) && readdirSync(PACKS).map((n) => join(PACKS, n)).find((p) => /geoid-egm2008-25-.*\.gwpack$/.test(p))) || process.env.GW_GEOID_PACK || '';
test.describe.configure({ timeout: 300000 });

const notesFor = async (frame, files, n) => {
  const log = await openFiles(frame, files);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  await frame.waitForFunction((n) => window.gisworkbench.pointClouds.size === n, n, { timeout: 120000 });
  return Object.fromEntries(log.filter((r) => /\.la[sz]$/.test(r.file)).map((r) => [r.file, r.warnings.join(' ')]));
};

test('REG-027 LAS warnings name EGM96 when it is the geoid in use', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const w = await notesFor(frame, [FX09('fx09_ftus.las')], 1);
  expect(w['fx09_ftus.las']).toMatch(/NAVD88 heights are converted to HAE with EGM96 \(no GEOID18 pack\)/);
  expect(logs).toEqual([]);
});

test('REG-027 LAS warnings name EGM2008 2.5′ when its pack is loaded', async ({ page }) => {
  test.skip(!PACK || !existsSync(PACK), 'needs the geoid-egm2008-25 pack (in the build or GW_GEOID_PACK)');
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [PACK]);
  await frame.waitForFunction(() => window.gisworkbench.core.geoidName === 'EGM2008 2.5′', null, { timeout: 180000 });
  const w = await notesFor(frame, [FX09('fx09_ftus.las'), FX09('fx09.laz')], 2);
  expect(w['fx09_ftus.las']).toMatch(/NAVD88 heights are converted to HAE with EGM2008 2\.5′ \(no GEOID18 pack\)/);
  expect(w['fx09_ftus.las']).not.toMatch(/EGM96/);
  expect(w['fx09.laz']).toMatch(/EGM96 heights are converted with EGM2008 2\.5′/);
  expect(logs).toEqual([]);
});
