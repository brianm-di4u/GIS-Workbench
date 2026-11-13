// #237: a project opens on its own, so the files given with it are not opened. That is now said: each
// one is in the import log, as an error naming the project, and in one message. Through a drop (the
// window's drop handler) and through API v2 layers.open, which is openFiles, as automation calls it.
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { openApp } from './helpers.js';

const RASTER = resolve('fixtures', 'fx25', 'aviation', 'nodata-utm15n-f32.tif');

test('REQ-ING-03 a project given with other files opens alone, and the import log names the files it did not open', async ({ page }, info) => {
  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  // An empty project, saved by the app itself.
  const b64 = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    let blob = null;
    app.saveCapture = (b) => (blob = b);
    await app.commands.run('file.save');
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode(...u8.subarray(k, k + 0x8000));
    return btoa(s);
  });
  const project = info.outputPath('site.gwb');
  writeFileSync(project, Buffer.from(b64, 'base64'));
  const input = await frame.evaluateHandle(() => Object.assign(document.body.appendChild(document.createElement('input')), { type: 'file', multiple: true, hidden: true }));
  await input.asElement().setInputFiles([project, RASTER]);

  const r = await frame.evaluate(async (i) => {
    const app = window.gisworkbench;
    const files = [...i.files];
    const newRows = async (fn) => {
      const n = app.importLog.length;
      await fn();
      return app.importLog.slice(n).map((e) => ({ file: e.file, errors: e.errors }));
    };
    // A drop of both files on the window.
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    const drop = await newRows(() => app.openDropped(dt, app.activePane()));
    const toast = [...document.querySelectorAll('.toast')].map((e) => e.textContent).find((x) => /A project opens alone/.test(x)) ?? null;
    // API v2, as automation and gwb-run open files.
    const api = await newRows(() => app.api.v2.layers.open({ files }));
    return { drop, api, toast, rasters: [...app.layers.values()].filter((l) => /nodata-utm15n/.test(l.rec?.name ?? '')).length };
  }, input);
  const row = { file: 'nodata-utm15n-f32.tif', errors: ['not opened: it was given with the project site.gwb, which opens alone'] };
  const opened = { file: 'site.gwb', errors: [] };
  // Logged after the project is read.
  expect(r.drop).toEqual([opened, row]);
  expect(r.api).toEqual([opened, row]);
  expect(r.toast).toMatch(/A project opens alone, so 1 file given with site\.gwb was not opened \(nodata-utm15n-f32\.tif\); the import log lists them/);
  expect(r.rasters).toBe(0);

  // Two other files: both in the log, the first named in the message with a count.
  const second = info.outputPath('second.tif');
  writeFileSync(second, 'not read');
  await input.asElement().setInputFiles([project, RASTER, second]);
  const two = await frame.evaluate(async (i) => {
    const app = window.gisworkbench;
    const n = app.importLog.length;
    await app.api.v2.layers.open({ files: [...i.files] });
    const toast = app.toastLog.map((e) => e.message).find((x) => /A project opens alone, so 2 files/.test(x)) ?? null;
    return { rows: app.importLog.slice(n).filter((e) => e.errors.length).map((e) => e.file), toast };
  }, input);
  expect(two.rows).toEqual(['nodata-utm15n-f32.tif', 'second.tif']);
  expect(two.toast).toMatch(/2 files given with site\.gwb were not opened \(nodata-utm15n-f32\.tif, …\)/);

  // A project that cannot be read: its own error comes first, and the other file is still named, in
  // words that do not claim the project opened.
  const bad = info.outputPath('broken.gwb');
  writeFileSync(bad, 'not a project');
  await input.asElement().setInputFiles([bad, RASTER]);
  const b = await frame.evaluate(async (i) => {
    const app = window.gisworkbench;
    const n = app.importLog.length;
    await app.api.v2.layers.open({ files: [...i.files] }).catch(() => null);
    return app.importLog.slice(n).map((e) => ({ file: e.file, failed: e.errors.length > 0, said: e.errors[0] ?? '' }));
  }, input);
  expect(b.map((e) => [e.file, e.failed])).toEqual([
    ['broken.gwb', true],
    ['nodata-utm15n-f32.tif', true],
  ]);
  expect(b[1].said).toBe('not opened: it was given with the project broken.gwb, which opens alone');
});
