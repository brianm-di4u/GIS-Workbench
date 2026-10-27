// R1 graphics (REQ-IMG-26/27/29/30): selection, Common Properties with anchor conversion,
// numbered sequence and count, copy/paste, legend, and GeoJSON (AT-02.5) and KML/KMZ round
// trips (REQ-EXT-23: GeoJSON Z = HAE; KML absolute altitudes as EGM96), DTD refusal (REQ-SEC-03).
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { openApp, openFiles, sample } from './helpers.js';

async function ready(page) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].every((l) => l.lutTex));
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    Object.assign(app.runMode.caps, { fsaSave: false, fsaPicker: false });
    app.activePane().setView({ cx: 768, cy: 768, zoom: 0.5, rot: 0, mode: 'native' });
  });
  return { frame, logs };
}
const scr = (frame, x, y) =>
  frame.evaluate(([x, y]) => {
    const p = window.gisworkbench.activePane();
    const r = p.el.getBoundingClientRect();
    const s = p.screenPoint(x, y);
    return { x: r.left + s.x, y: r.top + s.y };
  }, [x, y]);
const clickImg = async (page, frame, x, y, opts) => {
  const s = await scr(frame, x, y);
  await page.mouse.click(s.x, s.y, opts);
};

/** Draw a polygon, a marker and a three-point sequence through the tools. */
async function drawSome(page, frame) {
  await frame.evaluate(() => window.gisworkbench.tools.select('draw.polygon'));
  for (const [x, y] of [[500, 500], [700, 500], [700, 650]]) await clickImg(page, frame, x, y);
  await frame.evaluate(() => window.gisworkbench.tools.current.onEnter(window.gisworkbench.activePane()));
  await frame.waitForFunction(() => window.gisworkbench.store.all('graphic').length === 1);
  await frame.evaluate(() => window.gisworkbench.tools.select('draw.marker'));
  await clickImg(page, frame, 900, 900);
  await frame.waitForFunction(() => window.gisworkbench.store.all('graphic').length === 2);
  await frame.evaluate(() => window.gisworkbench.commands.run('draw.sequence'));
  for (const [x, y] of [[300, 1000], [350, 1050], [400, 1100]]) await clickImg(page, frame, x, y);
  await page.keyboard.press('Escape');
}

test('REQ-IMG-26 REQ-IMG-27 selection, Common Properties, anchors, sequence, count, copy/paste', async ({ page }) => {
  const { frame, logs } = await ready(page);
  await drawSome(page, frame);
  const seqs = await frame.evaluate(() => window.gisworkbench.store.all('graphic').filter((g) => g.seq).map((g) => g.seq));
  expect(seqs).toEqual([1, 2, 3]);
  // Click-select the polygon (inside it), then edit its properties.
  await frame.evaluate(() => window.gisworkbench.commands.run('sel.graphics'));
  await clickImg(page, frame, 660, 560);
  let selected = await frame.evaluate(() => [...window.gisworkbench.selection].map((id) => window.gisworkbench.store.get(id).shape));
  expect(selected).toEqual(['polygon']);
  // Shift adds the marker.
  await page.keyboard.down('Shift');
  await clickImg(page, frame, 900, 900);
  await page.keyboard.up('Shift');
  selected = await frame.evaluate(() => [...window.gisworkbench.selection].map((id) => window.gisworkbench.store.get(id).shape).sort());
  expect(selected).toEqual(['marker', 'polygon']);
  await frame.evaluate(() => void window.gisworkbench.commands.run('gfx.props'));
  const dlg = frame.locator('[data-id="dialog:gfx-props"]');
  await dlg.getByLabel('Line colour').fill('#00ff00');
  await dlg.getByLabel('Line width').fill('4');
  await dlg.getByLabel('Line style').selectOption('dashed');
  await dlg.getByLabel('Anchor', { exact: true }).selectOption('screen');
  await dlg.getByRole('button', { name: 'OK' }).click();
  const after = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const gs = [...app.selection].map((id) => app.store.get(id));
    const before = gs.map((g) => app.graphics.screenPoints(p, g, p.size().w, p.size().h));
    p.setView({ cx: 900, cy: 900 }); // screen-anchored graphics stay put
    const moved = gs.map((g) => app.graphics.screenPoints(p, app.store.get(g.id), p.size().w, p.size().h));
    return { styles: gs.map((g) => app.store.get(g.id).style), anchors: gs.map((g) => app.store.get(g.id).anchor), same: JSON.stringify(before) === JSON.stringify(moved) };
  });
  expect(after.anchors).toEqual(['screen', 'screen']);
  expect(after.same).toBe(true);
  for (const s of after.styles) expect(s).toMatchObject({ stroke: '#00ff00', width: 4, dash: 'dashed' });
  // Undo restores the ground anchors.
  await frame.evaluate(() => window.gisworkbench.undo.undo());
  expect(await frame.evaluate(() => window.gisworkbench.store.all('graphic').filter((g) => g.anchor === 'screen').length)).toBe(0);
  // Copy and paste: ground graphics paste on the same ground.
  await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.activePane().setView({ cx: 768, cy: 768 });
    await app.commands.run('edit.copy');
    app.commands.run('edit.paste');
  });
  const pasted = await frame.evaluate(() => {
    const all = window.gisworkbench.store.all('graphic');
    const src = all.find((g) => g.shape === 'polygon');
    const cp = all.filter((g) => g.shape === 'polygon')[1];
    return { n: all.length, same: JSON.stringify(src.coords) === JSON.stringify(cp?.coords) };
  });
  expect(pasted).toEqual({ n: 7, same: true });
  // Count: three clicks and Enter log a Count row.
  await frame.evaluate(() => window.gisworkbench.commands.run('draw.count'));
  for (const [x, y] of [[1000, 300], [1050, 320], [1100, 340]]) await clickImg(page, frame, x, y);
  await frame.evaluate(() => window.gisworkbench.tools.current.onEnter(window.gisworkbench.activePane()));
  const row = await frame.evaluate(() => window.gisworkbench.store.all('measurement').at(-1));
  expect(row).toMatchObject({ mtype: 'Count', value: 3, units: 'objects' });
  // Legend lists the shapes with counts.
  await frame.evaluate(() => void window.gisworkbench.commands.run('gfx.legend'));
  await expect(frame.locator('[data-id="dialog:gfx-legend"]')).toContainText('polygon (2)');
  expect(logs).toEqual([]);
});

test('AT-02.5 REQ-IMG-29 REQ-EXT-23 graphics round-trip through GeoJSON, KML and KMZ', async ({ page }) => {
  const { frame } = await ready(page);
  await drawSome(page, frame);
  const orig = await frame.evaluate(() => window.gisworkbench.store.all('graphic').map((g) => ({ shape: g.shape, coords: g.coords, style: g.style, seq: g.seq ?? null, text: g.text })));
  const files = {};
  for (const fmt of ['geojson', 'kml', 'kmz']) {
    await frame.evaluate(() => void window.gisworkbench.commands.run('gfx.save'));
    const dlg = frame.locator('[data-id="dialog:gfx-save"]');
    await dlg.locator('select').first().selectOption(fmt);
    const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Save' }).click()]);
    files[fmt] = await dl.path();
  }
  // GeoJSON: [lon, lat, HAE], no "crs" member (AT-17.3).
  const gj = JSON.parse(readFileSync(files.geojson, 'utf8'));
  expect(gj.crs).toBeUndefined();
  expect(gj.features[0].geometry.coordinates[0][0].length).toBe(3);
  // KML: absolute altitudes are EGM96 heights (HAE − N).
  const kml = readFileSync(files.kml, 'utf8');
  expect(kml).toContain('<altitudeMode>absolute</altitudeMode>');
  const firstAlt = Number(/<coordinates>[^,]+,[^,]+,([-\d.]+)/.exec(kml)[1]);
  const N = await frame.evaluate(([lon, lat]) => window.gisworkbench.core.undulation(lat, lon), orig[0].coords[0]);
  expect(Math.abs(firstAlt - (orig[0].coords[0][2] - N))).toBeLessThan(1e-3);
  const kmz = unzipSync(readFileSync(files.kmz));
  expect(strFromU8(kmz['doc.kml'])).toBe(kml);
  // Re-import each into a fresh panel and compare.
  for (const fmt of ['geojson', 'kml', 'kmz']) {
    const back = await (async () => {
      await frame.evaluate(() => {
        const app = window.gisworkbench;
        app.store.transact('clear', (tx) => app.store.all('graphic').forEach((g) => tx.delete(g.id)));
      });
      const [fc] = await Promise.all([page.waitForEvent('filechooser'), frame.evaluate(() => void window.gisworkbench.commands.run('gfx.load'))]);
      await fc.setFiles(files[fmt]);
      await frame.waitForFunction((n) => window.gisworkbench.store.all('graphic').length === n, orig.length, { timeout: 10000 });
      return frame.evaluate(() => window.gisworkbench.store.all('graphic').map((g) => ({ shape: g.shape, coords: g.coords, style: g.style, seq: g.seq ?? null, text: g.text })));
    })();
    for (let i = 0; i < orig.length; i++) {
      expect(back[i].shape, fmt).toBe(orig[i].shape);
      expect(back[i].seq, fmt).toBe(orig[i].seq);
      for (let k = 0; k < orig[i].coords.length; k++) {
        expect(Math.abs(back[i].coords[k][0] - orig[i].coords[k][0])).toBeLessThan(1e-9);
        expect(Math.abs(back[i].coords[k][1] - orig[i].coords[k][1])).toBeLessThan(1e-9);
        expect(Math.abs(back[i].coords[k][2] - orig[i].coords[k][2])).toBeLessThan(2e-3);
      }
      expect(back[i].style.stroke, fmt).toBe(orig[i].style.stroke);
      expect(back[i].style.width, fmt).toBe(orig[i].style.width);
      expect(back[i].style.fill, fmt).toBe(orig[i].style.fill);
    }
  }
});

test('REQ-SEC-03 KML with a DTD or entities is refused', async ({ page }) => {
  const { frame } = await ready(page);
  const dir = join(tmpdir(), 'gw-kml');
  mkdirSync(dir, { recursive: true });
  const bad = join(dir, 'evil.kml');
  writeFileSync(bad, '<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY x "boom">]><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>&x;</name><Point><coordinates>1,2,0</coordinates></Point></Placemark></Document></kml>');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), frame.evaluate(() => void window.gisworkbench.commands.run('gfx.load'))]);
  await fc.setFiles(bad);
  await expect(frame.locator('.toast', { hasText: 'DTD or entities is refused' })).toBeVisible();
  expect(await frame.evaluate(() => window.gisworkbench.store.all('graphic').length)).toBe(0);
});
