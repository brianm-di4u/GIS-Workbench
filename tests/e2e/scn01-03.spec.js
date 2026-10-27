// SCN-01 (first-phase quick report) and SCN-03 (mono mensuration) on FX-01 with the FX-05
// terrain (AC-01.1..01.5, AC-03.1..03.5): banners from FSCLAS within 2 s; Go To an MGRS
// within 1 px; a labelled read-out; a chip and a portion-marked quick report; 95 % of the 50
// truth points within 1 GSD; geodesic distance, CE/LE and area against GeographicLib.
// REQ-FMT-15: FX-01 and FX-05 come from build/fixtures/fx01.mjs with machine-readable truth.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import geodesicPkg from 'geographiclib-geodesic';
import { openApp, openFiles } from './helpers.js';

const FX01 = resolve('fixtures/fx01/fx01.ntf');
const FX05 = resolve('fixtures/fx05/fx05_dem_hae.tif');
const truth = JSON.parse(readFileSync(resolve('fixtures/fx01/fx01_truth.json'), 'utf8'));
const geod = geodesicPkg.Geodesic.WGS84;

async function ready(page, { dem = true } = {}) {
  const { frame, logs } = await openApp(page, 'file');
  const t0 = Date.now();
  await openFiles(frame, [FX01]);
  await frame.locator('.multiport .pane .banner-top').first().waitFor();
  await frame.waitForFunction(() => {
    const p = document.querySelector('.multiport .pane');
    return p && /UNCLASSIFIED/.test(p.querySelector('.banner-top')?.textContent ?? '') && /UNCLASSIFIED/.test(p.querySelector('.banner-bottom')?.textContent ?? '');
  });
  const bannerMs = Date.now() - t0;
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex));
  if (dem) {
    await openFiles(frame, [FX05]);
    await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].length === 2 && [...window.gisworkbench.layers.values()].every((l) => l.stats));
    await frame.evaluate(async () => {
      const app = window.gisworkbench;
      const dem = [...app.layers.values()].find((l) => /fx05/.test(l.rec.name));
      await app.useAsTerrain(dem, 'hae');
      const img = [...app.layers.values()].find((l) => /fx01/.test(l.rec.name));
      app.store.transact('hide dem', (tx) => {
        tx.set(dem.id, 'visible', false);
        tx.set(app.activePane().id, 'activeLayer', img.id); // the analyst works on the image
      });
    });
    await frame.waitForFunction(() => window.gisworkbench.terrain.available);
  }
  return { frame, logs, bannerMs };
}

test('SCN-01 AC-01.1..01.5 open, banners, Go To, read-out, chip and quick report', async ({ page }) => {
  const { frame, logs, bannerMs } = await ready(page);
  // AC-01.1: the banner comes from the file's security fields, top and bottom, within 2 s.
  expect(bannerMs).toBeLessThan(2000);
  const info = await frame.evaluate(() => {
    const l = [...window.gisworkbench.layers.values()].find((x) => /fx01/.test(x.rec.name));
    return { marking: l.info.marking, model: l.modelName, sun: l.info.sun, iid: l.info.iid };
  });
  expect(info.marking).toMatchObject({ level: 'U', system: 'US' });
  expect(info.model).toMatch(/^RPC00B/);
  expect(info.sun).toMatchObject({ azimuth: 148, elevation: 52.5 });
  // AC-01.2: Go To each of five truth MGRS strings centres within 1 px of the decoded point.
  const errs = [];
  for (const t of truth.points.slice(0, 5)) {
    errs.push(
      await frame.evaluate(async (t) => {
        const app = window.gisworkbench;
        const p = app.activePane();
        const l = p.geoLayer();
        const r = await app.jumpTo(t.mgrs);
        const h = app.terrain.sample(r.lat, r.lon).hae;
        const q = l.imageAt(r.lat, r.lon, h);
        // The MGRS square holds the truth point; the view centre is its decoded position.
        return { d: Math.hypot(p.view.cx - q.x, p.view.cy - q.y), truthPx: Math.hypot(p.view.cx - t.x, p.view.cy - t.y) };
      }, t),
    );
  }
  for (const e of errs) {
    expect(e.d).toBeLessThan(1);
    expect(e.truthPx).toBeLessThan(4); // a 1 m MGRS square is 2 px at 0.5 m GSD
  }
  // AC-01.3: the read-out: DMS and decimal, 10-digit MGRS, height with its reference, datum.
  const box = await frame.locator('.multiport .pane').first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  const cur = await frame.locator('[data-id="status:cursor"]').first().textContent();
  const gr = await frame.locator('[data-id="status:ground"]').first().textContent();
  expect(cur).toMatch(/\d+°\s*\d+['′]\s*[\d.]+["″]\s*[NS]/);
  expect(cur).toMatch(/\(\d+\.\d{6}°[NS] \d+\.\d{6}°[EW]\)/);
  expect(cur).toContain('WGS 84');
  expect(gr).toMatch(/MGRS \d{1,2}[C-X][A-Z]{2}\d{10}/);
  expect(gr).toMatch(/m HAE/);
  // AC-01.4 (chip) and AC-01.5 (quick report: portion marks, chip, MGRS, image reference).
  const rep = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const chip = await app.makeChip({ width: 800, height: 600 });
    app.store.transact('chip', (tx) => tx.create('chip', { ...chip.record, pane: app.activePane().id }));
    app.chipImages.set(chip.record.number, chip.canvas.toDataURL('image/jpeg', 0.8));
    app.store.transact('obs', (tx) => tx.create('observation', { text: '(U) Two buildings in the north-east block (test value).', confidence: 'moderate', image: 'FX01' }));
    const html = app.buildReport({ title: 'Quick report', bluf: '(U) The site is active (test value).', type: 'First phase (IPIR-style)' });
    const body = new DOMParser().parseFromString(html, 'text/html');
    const paras = [...body.querySelectorAll('main p, main li')].filter((e) => !e.classList.contains('note')).map((e) => e.textContent.trim());
    return { rec: chip.record, paras, img: body.querySelectorAll('figure img').length, mgrs: /MGRS \d{1,2}[C-X][A-Z]{2}\d{10}/.test(html), image: html.includes('FX01'), banners: [...html.matchAll(/class="banner (top|bottom)"/g)].length };
  });
  expect(rep.rec.caption).toMatch(/FX01/);
  expect(rep.rec.caption).toMatch(/2026-03-15 18:30:00Z/);
  expect(rep.rec.scaleBar).not.toBeNull();
  for (const p of rep.paras) expect(p, p).toMatch(/^\([URCST]\)/);
  expect(rep.img).toBe(1);
  expect(rep.mgrs).toBe(true);
  expect(rep.image).toBe(true);
  expect(rep.banners).toBe(2);
  expect(logs).toEqual([]);
});

test('SCN-03 AC-03.1..03.5 truth points, distance, CE/LE, error not available, area', async ({ page }) => {
  const { frame } = await ready(page);
  // AC-03.1: image → DEM-intersected ground for the 50 truth points.
  const r = await frame.evaluate((pts) => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()].find((x) => /fx01/.test(x.rec.name));
    return pts.map((t) => {
      const g = l.groundWithTerrain(t.x, t.y);
      return { d: app.core.inverse(g.lat, g.lon, t.lat, t.lon).distance, dh: g.h - t.hae, src: g.heightSource ?? g.source ?? null };
    });
  }, truth.points);
  const within = r.filter((x) => x.d <= truth.gsd).length;
  expect(within / r.length).toBeGreaterThanOrEqual(0.95);
  // AC-03.2: a 10 km geodesic against GeographicLib within 1 mm.
  const [lat1, lon1] = [truth.points[0].lat, truth.points[0].lon];
  const dir = geod.Direct(lat1, lon1, 63.2, 10000);
  const d = await frame.evaluate(([a, b, c, e]) => window.gisworkbench.core.inverse(a, b, c, e).distance, [lat1, lon1, dir.lat2, dir.lon2]);
  expect(Math.abs(d - 10000)).toBeLessThan(0.001);
  // AC-03.3: circular case CE90 = 2.146 σ, LE90 = 1.645 σ.
  const ce = await frame.evaluate(() => [window.gisworkbench.core.ce90(4, 0, 4), window.gisworkbench.core.le90(3)]);
  expect(Math.abs(ce[0] / 2 - 2.146) / 2.146).toBeLessThan(0.01);
  expect(Math.abs(ce[1] / 3 - 1.645) / 1.645).toBeLessThan(0.01);
  // AC-03.4: a model without error data says "error not available", never blank.
  const na = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()].find((x) => /fx05/.test(x.rec.name));
    const e = app.core.pointError(l.modelId, 100, 100, 640, 0.5);
    return { ce90: e.ce90, row: app.measureApi?.baseRow?.('Point', l, { lat: 34.5, lon: -116.5, h: 640, x: 100, y: 100 })?.ce90 };
  });
  expect(Number.isFinite(na.ce90)).toBe(false);
  // AC-03.5: a 1 km² square against GeographicLib within 0.1 %.
  const sq = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]].map(([e, n]) => {
    const a = geod.Direct(lat1, lon1, 90, e);
    const b = geod.Direct(a.lat2, a.lon2, 0, n);
    return [b.lat2, b.lon2];
  });
  const poly = geod.Polygon(false);
  for (const [la, lo] of sq) poly.AddPoint(la, lo);
  const ref = Math.abs(poly.Compute(false, true).area);
  const ours = await frame.evaluate((pts) => Math.abs(window.gisworkbench.core.polygonArea(pts).area), sq);
  expect(Math.abs(ours - ref) / ref).toBeLessThan(0.001);
});
