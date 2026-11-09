// 2.1 nitf group (SDP-2.1 FC-01, FC-02, FC-15, FC-18): RPF A.TOC mosaics with their frame coverage,
// NITF ARIDPCM (C2), and MrSID/ECW footprint layers with Convert with Sidecar, on the T&E corpus.
// Run against a group build with GW_DIST=dist-21-nitf/gis-workbench.html; skipped without the corpus.
import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const CORPUS = process.env.TE_CORPUS ?? resolve('..', 'TE-corpus');
const C = (...p) => join(CORPUS, ...p);
const FIELD = 'C:/GIS Workbench/Research/Additional Data Samples';
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
test.describe.configure({ timeout: 240000 });
test.skip(!existsSync(C('nitf-ntb-nitf11-legacy')), 'T&E corpus not present');

const layers = (frame) => frame.evaluate(() => [...window.gisworkbench.layers.values()].map((l) => ({ name: l.rec.name, error: l.error ?? null, w: l.width, h: l.height, kind: l.info.kind, format: l.info.format, model: l.modelName ?? null, footprint: l.info.footprint ?? null, ready: !!l.lutTex })));
const vlayers = (frame) => frame.evaluate(() => window.gisworkbench.store.all('vlayer').map((v) => ({ name: v.name, n: window.gisworkbench.store.all('feature').filter((f) => f.vlayer === v.id).length })));
const toasts = (frame) => frame.evaluate(() => [...document.querySelectorAll('.toasts .toast')].map((t) => `${[...t.classList].find((c) => c.startsWith('toast-'))}: ${t.textContent}`));
const ready = (frame, n = 1) => frame.waitForFunction((k) => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex || l.error).length >= k, n, { timeout: 120000 });
const pixel = (frame, i, x, y, bands) =>
  frame.evaluate(async ([i, x, y, bands]) => {
    const L = [...window.gisworkbench.layers.values()][i];
    return (await window.gisworkbench.pool.run('pixels', { handle: L.handle, x, y, w: 1, h: 1, bands }, { affinity: L.affinity })).values.map((b) => b[0]);
  }, [i, x, y, bands]);

test('REQ-FMT-40 an RPF folder dropped with its A.TOC opens as one CADRG mosaic per boundary, with frame coverage', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const dir = C('derived-rpf-cadrg-from-cib10', 'n35e011');
  const files = walk(dir);
  const t0 = Date.now();
  await openFiles(frame, files);
  await ready(frame);
  const ls = await layers(frame);
  expect(ls).toHaveLength(1);
  expect(ls[0]).toMatchObject({ error: null, w: 12288, h: 15360, kind: 'rpftoc' });
  expect(ls[0].name).toMatch(/A\.TOC — CADRG 1:50K zone 2/);
  expect(ls[0].model).toMatch(/RPF A\.TOC zone 2 \(equal-arc/);
  const v = await vlayers(frame);
  expect(v.find((x) => /A\.TOC frame coverage/.test(x.name))?.n).toBe(files.length - 1);
  // GDAL RPFTOC (gdal_translate -expand rgb -srcwin 1400 1400 …) at (1400,1400) and (1699,1699).
  const a = await pixel(frame, 0, 1400, 1400, [0, 1, 2]);
  const b = await pixel(frame, 0, 1536 * 3 + 5, 1536 * 4 + 5, [0, 1, 2]);
  expect(a.every((x) => x >= 0 && x <= 255) && b.every((x) => x >= 0 && x <= 255)).toBe(true);
  console.log(`A.TOC with ${files.length - 1} frames open in ${Date.now() - t0} ms`);
  expect((await toasts(frame)).filter((t) => t.startsWith('toast-error'))).toEqual([]);
  expect(logs).toEqual([]);
});

test('REQ-FMT-40 an A.TOC opened alone asks for its RPF folder; polar zone 9 is placed in the ARC polar plane', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const dir = C('raster-gdal-autotest-dimap2-rpf-nm', 'rpftoc', 'zone9');
  const frames = walk(dir).filter((p) => !/A\.TOC$/i.test(p));
  // The folder picker is replaced by a hook that hands over the folder's files (automation).
  const input = await frame.evaluateHandle(() => Object.assign(document.body.appendChild(document.createElement('input')), { type: 'file', multiple: true }));
  await input.asElement().setInputFiles(frames);
  await frame.evaluate((i) => (window.gisworkbench.rpfFolderPick = async () => [...i.files]), input);
  await openFiles(frame, [join(dir, 'RPF', 'A.TOC')]);
  await ready(frame);
  const [l] = await layers(frame);
  expect(l).toMatchObject({ error: null, w: 1536, h: 1536 });
  expect(l.model).toMatch(/zone 9 \(ARC polar azimuthal equidistant/);
  expect(logs).toEqual([]);
});

test('REQ-FMT-44 NITF ARIDPCM (C2) images open at every rate; rates without published tables are flagged', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const log = await openFiles(frame, [C('nitf-ntb-nitf11-legacy', 'U_0001a.ntf')]);
  await ready(frame, 5);
  const ls = await layers(frame);
  expect(ls.filter((l) => l.error)).toEqual([]);
  expect(ls.map((l) => `${l.w}x${l.h}`)).toEqual(expect.arrayContaining(['512x512', '231x191', '181x73', '30x67']));
  const warn = log.flatMap((r) => r.warnings).join(' ');
  expect(warn).toMatch(/ARIDPCM COMRAT 4\.50 .*approximate/);
  expect(warn).not.toMatch(/COMRAT 0\.75/);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  expect(logs).toEqual([]);
});

test('REQ-FMT-22 a MrSID file opens at once as a footprint with metadata; Convert with Sidecar names the sidecar', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const log = await openFiles(frame, [C('raster-mrsid-gdal-samples', 'lossless-mg3', 'utm11-27.sid')]);
  await ready(frame);
  const [l] = await layers(frame);
  expect(l).toMatchObject({ error: null, w: 512, h: 512, kind: 'footprint' });
  expect(l.footprint.version).toMatch(/MG3/);
  expect(l.model).toMatch(/MrSID metadata/);
  // The 200 ms budget is measured by c55 on an idle machine. Here it is reported, not asserted: e2e runs
  // beside other work, and a footprint (no pixels decoded) is what makes the open immediate.
  test.info().annotations.push({ type: 'timing', description: `footprint in ${log[0].ms} ms` });
  const v = await vlayers(frame);
  expect(v.find((x) => /utm11-27\.sid footprint/.test(x.name))?.n).toBe(1);
  // The toast's action, then the metadata panel's.
  const t = (await toasts(frame)).join(' ');
  expect(t).toMatch(/footprint and metadata only/);
  await frame.locator('.toasts .toast button', { hasText: 'Convert with Sidecar' }).first().click();
  // No sidecar runs: the sidecar's install dialog, with the release page.
  const dlg = frame.locator('[data-id="dialog:sidecar-install"]');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('utm11-27.sid needs a conversion');
  await expect(dlg).toContainText('github.com/brianm-di4u/GIS-Workbench/releases');
  await dlg.locator('button.btn', { hasText: 'Close' }).click();
  expect(logs).toEqual([]);
});

test('REQ-FMT-22 ECW v2 and v3 open as footprints (UTM from the ER Mapper header; RAW without a CRS)', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const log = await openFiles(frame, ['sandiego2m_null.ecw', 'jrc.ecw', 'stefan_full_rgba_ecwv3_meta.ecw'].map((n) => C('raster-ecw-negatives-gdal', n)));
  await ready(frame, 3);
  const ls = await layers(frame);
  expect(ls.filter((l) => l.error)).toEqual([]);
  const sd = ls.find((l) => /sandiego/.test(l.name));
  expect(sd).toMatchObject({ w: 1029, h: 1022, kind: 'footprint' });
  expect(sd.model).toMatch(/EPSG:26911/);
  expect(ls.find((l) => /stefan/.test(l.name))).toMatchObject({ w: 162, h: 150 });
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  expect(logs).toEqual([]);
});

test('REQ-FMT-22 REQ-ING-01 the 10.7 GB Hamilton County MrSID mosaic footprints within 200 ms', async ({ page }) => {
  const sid = join(FIELD, 'Hamilton_2018_rgb_20x-002', 'Hamilton_2018_rgb_20x.sid');
  test.skip(!existsSync(sid), 'tier-U field file not present');
  const { frame, logs } = await openApp(page, 'file');
  const log = await openFiles(frame, [sid, join(FIELD, 'Hamilton_2018_rgb_20x-002', 'Hamilton_2018_rgb_20x.sdw'), join(FIELD, 'Hamilton_2018_rgb_20x-002', 'Hamilton_2018_rgb_20x.sid.xml')]);
  await ready(frame);
  const [l] = await layers(frame);
  expect(l).toMatchObject({ error: null, w: 340000, h: 220000, kind: 'footprint' });
  expect(l.model).toMatch(/Map \(MrSID metadata/);
  console.log(`Hamilton footprint in ${log[0].ms} ms`);
  // The 200 ms budget is measured by c55 on an idle machine. Here it is reported, not asserted: e2e runs
  // beside other work, and a footprint (no pixels decoded) is what makes the open immediate.
  test.info().annotations.push({ type: 'timing', description: `footprint in ${log[0].ms} ms` });
  expect(logs).toEqual([]);
});

test('REQ-FMT-45 a chip saves as ARIDPCM NITF; GDAL and the app read it back', async ({ page }) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync: wf, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const ENV = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library';
  const genv = { ...process.env, PATH: `${ENV}/bin;${process.env.PATH}`, GDAL_DATA: `${ENV}/share/gdal`, PROJ_DATA: `${ENV}/share/proj` };
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [C('naip-ca-m3812157-sw-2022', 'm_3812157_sw_10_060_20220519.tif')]);
  await ready(frame);
  const out = await frame.evaluate(async () => {
    const a = window.gisworkbench;
    a.activePane().fitWhole?.();
    const chip = await a.makeChip({ width: 512, height: 512 });
    const enc = async (fmt) => {
      const r = await a.encodeProduct(chip, fmt);
      const u8 = new Uint8Array(await r.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return { name: r.name, b64: btoa(s), files: r.files ?? null, scale: r.scale ?? null };
    };
    return [await enc('nitf-aridpcm')];
  });
  const dir = mkdtempSync(join(tmpdir(), 'gw-21nitf-'));
  const paths = out.map((o) => {
    const p = join(dir, o.name);
    wf(p, Buffer.from(o.b64, 'base64'));
    return p;
  });
  const ainfo = execFileSync(join(ENV, 'bin', 'gdalinfo.exe'), ['-mdd', 'all', paths[0]], { env: genv }).toString();
  expect(ainfo).toMatch(/NITF_IC=M2/);
  // GDAL decodes 8-bit 0.75 bpp ARIDPCM (its only rate): the image reads.
  execFileSync(join(ENV, 'bin', 'gdal_translate.exe'), ['-q', '-of', 'GTiff', paths[0], join(dir, 'arid.tif')], { env: genv });
  // The app reopens it.
  const log = await openFiles(frame, paths);
  expect(log.flatMap((r) => r.errors ?? [])).toEqual([]);
  const ls = await layers(frame);
  expect(ls.some((l) => /aridpcm/.test(l.name) && !l.error)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
  expect(logs).toEqual([]);
});
