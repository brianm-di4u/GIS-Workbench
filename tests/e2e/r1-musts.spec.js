// R1 Musts that the scenario tests exercise only in passing, checked directly on the built file:
// honest limits and marking (REQ-SEC-04/05/07/09), shell (REQ-UI-01/05/08/09/17/18), rendering
// (REQ-IMG-01/02/03/11/12/19/33), mensuration and geodesy (REQ-MEN-01/05/06, REQ-GEO-05/07/08/
// 10/11), sensor models (REQ-SNS-06/07/08), DTED (REQ-DEM-01, REQ-FMT-07) and TREs (REQ-FMT-03).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles, sample } from './helpers.js';

const FX01 = resolve('fixtures/fx01/fx01.ntf');
const FX03 = resolve('fixtures/fx03/fx03.ntf');
const DT2 = resolve('fixtures/fx05/w117_n34.dt2');
const truth01 = JSON.parse(readFileSync(resolve('fixtures/fx01/fx01_truth.json'), 'utf8'));
const truth03 = JSON.parse(readFileSync(resolve('fixtures/fx03/fx03_truth.json'), 'utf8'));

async function withFx01(page) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [FX01]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex && !l.tiles.loading));
  return { frame, logs };
}
const closeDialog = (frame, id) => frame.locator(`[data-id="dialog:${id}"] .dlg-x`).click();

/** NOAA solar position (azimuth from north, elevation), an oracle independent of the core. */
function noaaSun(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const r = Math.PI / 180;
  const C = Math.sin(M * r) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * r) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * r) * 0.000289;
  const lam = L0 + C - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * T) * r);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos((125.04 - 1934.136 * T) * r);
  const dec = Math.asin(Math.sin(eps * r) * Math.sin(lam * r)) / r;
  const y = Math.tan((eps / 2) * r) ** 2;
  const eqt = (4 / r) * (y * Math.sin(2 * L0 * r) - 2 * e * Math.sin(M * r) + 4 * e * y * Math.sin(M * r) * Math.cos(2 * L0 * r) - 0.5 * y * y * Math.sin(4 * L0 * r) - 1.25 * e * e * Math.sin(2 * M * r));
  const mins = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const ha = (mins + eqt + 4 * lon) / 4 - 180;
  const zen = Math.acos(Math.sin(lat * r) * Math.sin(dec * r) + Math.cos(lat * r) * Math.cos(dec * r) * Math.cos(ha * r)) / r;
  const az = (Math.atan2(Math.sin(ha * r), Math.cos(ha * r) * Math.sin(lat * r) - Math.tan(dec * r) * Math.cos(lat * r)) / r + 180) % 360;
  return { azimuth: az, elevation: 90 - zen };
}

test('REQ-SEC-04 REQ-SEC-05 REQ-SEC-07 REQ-SEC-09 marking in titles, honest limits, no vendor names', async ({ page }) => {
  const { frame, logs } = await withFx01(page);
  const title = await frame.evaluate(() => [...document.querySelectorAll('.gwin-title, .mp-title, [class*="title"]')].map((e) => e.textContent).join(' | '));
  expect(title).toMatch(/U - Unclassified/);
  await frame.evaluate(() => void window.gisworkbench.commands.run('help.about'));
  await expect(frame.locator('[data-id="dialog:about"]')).toContainText('not an accredited marking system');
  await closeDialog(frame, 'about');
  await frame.evaluate(() => void window.gisworkbench.commands.run('help.limits'));
  await expect(frame.locator('[data-id="dialog:limits"]')).toContainText('does not claim MSP, CSM, JITC NITF, STANAG 3377 or ISM conformance');
  await closeDialog(frame, 'limits');
  // The tool's own name everywhere a user reads: labels, tooltips, help text.
  const text = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const cmds = [...app.commands.map.values()].map((c) => `${c.label} ${c.tip ?? ''}`).join('\n');
    const titles = [...document.querySelectorAll('[title],[aria-label]')].map((e) => `${e.getAttribute('title') ?? ''} ${e.getAttribute('aria-label') ?? ''}`).join('\n');
    return `${document.body.innerText}\n${cmds}\n${titles}\n${document.title}`;
  });
  expect(text).not.toMatch(/\bGXP\b|\bBAE\b|SOCET/);
  expect(text).toMatch(/GIS Workbench/);
  expect(logs).toEqual([]);
});

test('REQ-UI-01 REQ-UI-05 REQ-UI-18 workspace views, docks that float, tab and persist, Layer Manager', async ({ page }) => {
  const { frame } = await withFx01(page);
  for (const t of ['Data View', 'Windows View', 'Map View', 'Preview']) await expect(frame.getByText(t, { exact: true }).first()).toBeVisible();
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const mp = app.activeMp();
    const D = mp.docks;
    D.show('layers', 'left');
    const p = D.panel('layers');
    D.float(p);
    const floating = !!p.floatWin;
    const saved = D.layout();
    D.unfloat(p);
    D.restore(saved);
    const restored = !!D.panel('layers').floatWin;
    D.unfloat(D.panel('layers'));
    // Layer Manager: visibility, opacity, order and the active layer live on the layer record.
    const l = app.activeLayer();
    app.store.transact('t', (tx) => {
      tx.set(l.id, 'opacity', 0.4);
      tx.set(l.id, 'visible', false);
    });
    const vis = app.activePane().visibleLayers().length;
    app.store.transact('t', (tx) => tx.set(l.id, 'visible', true));
    return { floating, restored, layout: !!saved, opacity: l.opacity, vis, panelText: D.panel('layers').el.textContent };
  });
  expect(r.floating).toBe(true);
  expect(r.restored).toBe(true);
  expect(r.opacity).toBe(0.4);
  expect(r.vis).toBe(0);
  expect(r.panelText).toMatch(/fx01/);
});

test('REQ-UI-08 REQ-UI-09 REQ-IMG-11 mouse grammar, hot keys, pan zone and the zoom ladder', async ({ page }) => {
  const { frame } = await withFx01(page);
  const box = await frame.locator('.multiport .pane').first().boundingBox();
  const at = [box.x + box.width * 0.3, box.y + box.height * 0.4];
  const under = () => frame.evaluate(([x, y]) => {
    const p = window.gisworkbench.activePane();
    const r = p.el.getBoundingClientRect();
    return p.imagePoint(x - r.left, y - r.top);
  }, at);
  // Wheel zooms about the cursor: the image point under it stays put.
  await frame.evaluate(() => window.gisworkbench.activePane().setView({ cx: 2048, cy: 2048, zoom: 0.3, rot: 0, mode: 'native' }));
  const before = await under();
  await page.mouse.move(...at);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(200);
  const after = await under();
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1.5);
  const z = await frame.evaluate(() => window.gisworkbench.activePane().view.zoom);
  expect(z).toBeGreaterThan(0.3);
  // Double-click centres and zooms; middle-button roams.
  await page.mouse.dblclick(...at);
  const v1 = await frame.evaluate(() => window.gisworkbench.activePane().view);
  expect(Math.hypot(v1.cx - after.x, v1.cy - after.y)).toBeLessThan(2);
  expect(v1.zoom).toBeGreaterThan(z);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 3 });
  await page.waitForTimeout(250);
  await page.mouse.up({ button: 'middle' });
  const v2 = await frame.evaluate(() => window.gisworkbench.activePane().view);
  expect(v2.cx).not.toBeCloseTo(v1.cx, 0);
  // Hot keys with the panel focused: W whole scene, + zooms by √2, Ctrl+Alt+1 is 1:1.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('w');
  const whole = await frame.evaluate(() => {
    const p = window.gisworkbench.activePane();
    const { w, h } = p.size();
    return { zoom: p.view.zoom, fit: Math.min(w / 4096, h / 4096) };
  });
  expect(Math.abs(whole.zoom - whole.fit) / whole.fit).toBeLessThan(0.1);
  await page.keyboard.press('Equal');
  const zin = await frame.evaluate(() => window.gisworkbench.activePane().view.zoom);
  expect(zin / whole.zoom).toBeCloseTo(Math.SQRT2, 2);
  await page.keyboard.press('Control+Alt+Digit1');
  const one = await frame.evaluate(() => window.gisworkbench.activePane().view.zoom * (window.devicePixelRatio || 1));
  expect(one).toBeGreaterThan(0.9);
  // Space pan zone: hold Space and move the mouse.
  const p0 = await frame.evaluate(() => ({ ...window.gisworkbench.activePane().view }));
  await page.keyboard.down('Space');
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 4 });
  await page.keyboard.up('Space');
  const p1 = await frame.evaluate(() => window.gisworkbench.activePane().view);
  expect(Math.hypot(p1.cx - p0.cx, p1.cy - p0.cy)).toBeGreaterThan(10);
  // Esc ends a tool; a double-clicked tool is sticky.
  const t = await frame.evaluate(() => {
    const app = window.gisworkbench;
    app.tools.select('zoombox', { sticky: true });
    return { sticky: app.tools.sticky, id: app.tools.current?.id };
  });
  expect(t).toEqual({ sticky: true, id: 'zoombox' });
  await page.keyboard.press('Escape');
  expect(await frame.evaluate(() => window.gisworkbench.tools.current)).toBeNull();
  // Customize Hot Keys: browser-kept chords are refused, panel chords move, the dialog opens.
  const k = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const refused = app.assignHotkey('nav.whole', 'Mod+KeyT');
    const focusOnly = app.assignHotkey('nav.whole', 'F5');
    const ok = app.assignHotkey('nav.whole', 'KeyH', 'pane');
    const map = app.keys.keyMap().pane;
    return { refused, focusOnly, ok, h: map.KeyH, w: map.KeyW ?? null };
  });
  expect(k.refused).toMatch(/belongs to the browser/);
  expect(k.focusOnly).toMatch(/only while a panel has focus/);
  expect(k.ok).toBeNull();
  expect(k.h).toBe('nav.whole');
  expect(k.w).toBeNull();
  await frame.evaluate(() => void window.gisworkbench.commands.run('keys.customize'));
  await expect(frame.locator('[data-id="dialog:keys-customize"]')).toContainText('Whole Scene');
  await closeDialog(frame, 'keys-customize');
});

test('REQ-UI-17 UI scale and device pixels', async ({ page }) => {
  const { frame } = await withFx01(page);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const probe = document.querySelector('.statusbar');
    const h0 = probe.getBoundingClientRect().height;
    app.setUiScale(1.25);
    await new Promise((res) => setTimeout(res, 100));
    const h1 = probe.getBoundingClientRect().height;
    app.setUiScale(1);
    const gl = app.renderer.gl.canvas;
    return { h0, h1, gl: [gl.width, gl.height], css: [gl.getBoundingClientRect().width, gl.getBoundingClientRect().height], dpr: window.devicePixelRatio || 1 };
  });
  expect(r.h1 / r.h0).toBeGreaterThan(1.15);
  expect(Math.abs(r.gl[0] - Math.round(r.css[0] * r.dpr))).toBeLessThanOrEqual(2);
});

test('REQ-IMG-01 REQ-IMG-02 REQ-IMG-03 REQ-IMG-33 one context, integer textures, kernels, tiles, software fallback', async ({ page }) => {
  const { frame } = await withFx01(page);
  await frame.evaluate(() => window.gisworkbench.activeMp().setLayout('2x2'));
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const gl = app.renderer.gl;
    const canvases = [...document.querySelectorAll('canvas')];
    const others = canvases.filter((c) => c !== gl.canvas).map((c) => !!c.getContext('2d'));
    const l = app.activeLayer();
    const kernelDefault = l.chain.kernel;
    const menu = app.commands.get('view.interpolation').options().map((m) => m.label);
    app.softwareGl = true;
    const soft = l.kernelEffective;
    app.softwareGl = false;
    return { webgl2: gl instanceof WebGL2RenderingContext, panes: app.activeMp().panes.length, others, texKind: l.texKind, sampleType: l.sampleType, kernelDefault, menu, soft, hard: l.kernelEffective, levels: l.levels, gpu: [app.renderer.gpuBytes, app.renderer.gpuBudget] };
  });
  expect(r.webgl2).toBe(true);
  expect(r.panes).toBe(4);
  expect(r.others.every(Boolean)).toBe(true); // every other canvas is 2-D: one WebGL2 context drives all panes
  expect(r.sampleType).toBe('u8');
  expect(r.texKind).toBe('u'); // R8UI integer texture; DN kept until the LUT
  expect(r.kernelDefault).toBe('bicubic');
  expect(r.menu.join(' ')).toMatch(/Nearest.*Bilinear.*Bicubic.*Lanczos/);
  expect(r.soft).toBe('bilinear');
  expect(r.hard).toBe('bicubic');
  expect(r.levels).toBeGreaterThanOrEqual(4); // pyramid built in workers for an image without overviews
  expect(r.gpu[1]).toBeLessThanOrEqual(384 * 2 ** 20);
  expect(r.gpu[0]).toBeLessThanOrEqual(r.gpu[1]);
});

test('REQ-IMG-12 REQ-IMG-19 rotation modes from the sensor model, footprints and void removal', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  await openFiles(frame, [FX03]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex));
  const pole = truth03.objects.find((o) => o.id === 'P3');
  const r = await frame.evaluate(async (pole) => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const l = p.geoLayer();
    p.setView({ cx: pole.base.x, cy: pole.base.y, zoom: 1, rot: 0, mode: 'native' });
    const dir = (q) => {
      const a = p.screenPoint(pole.base.x, pole.base.y);
      const b = p.screenPoint(q.x, q.y);
      return (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI; // 0 = screen up, clockwise
    };
    const north = () => {
      const g = l.groundAt(p.view.cx, p.view.cy);
      const t = app.core.direct(g.lat, g.lon, 0, 50);
      return dir(l.imageAt(t.lat, t.lon, g.h));
    };
    const out = {};
    app.commands.run('rot.north');
    out.north = north();
    app.commands.run('rot.upisup');
    out.up = dir(pole.top);
    app.commands.run('rot.shadows');
    out.shadow = dir(pole.shadowTip);
    app.commands.run('rot.zero');
    out.zero = p.view.rot;
    // Footprint of the image in the map view, and void removal in the chain.
    const fp = l.footprint();
    const c = { lat: pole.base.lat, lon: pole.base.lon };
    const inside = (() => {
      let k = false;
      for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) if (fp[i][0] > c.lat !== fp[j][0] > c.lat && c.lon < ((fp[j][1] - fp[i][1]) * (c.lat - fp[i][0])) / (fp[j][0] - fp[i][0]) + fp[i][1]) k = !k;
      return k;
    })();
    out.voidsDefault = l.chain.voids !== false; // void pixels are removed by default
    await app.commands.run('clip.void');
    out.voidsAfter = l.chain.voids !== false;
    return { ...out, inside, fpLen: fp.length };
  }, pole);
  expect(Math.abs(r.north)).toBeLessThan(0.5);
  expect(Math.abs(r.up)).toBeLessThan(0.5);
  expect(Math.abs(Math.abs(r.shadow) - 180)).toBeLessThan(0.5);
  expect(r.zero).toBe(0);
  expect(r.fpLen).toBe(4);
  expect(r.inside).toBe(true);
  expect(r.voidsDefault).toBe(true);
  expect(r.voidsAfter).toBe(false);
});

test('REQ-MEN-01 REQ-MEN-05 REQ-MEN-06 REQ-GEO-05 log rows, tracking, CE90/CE95/LE90 and the geodesic method', async ({ page }) => {
  const { frame } = await withFx01(page);
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const l = p.geoLayer();
    const a = l.groundWithTerrain(1500, 1500);
    const b = l.groundWithTerrain(2600, 2300);
    const api = app.measureApi;
    api.logRow(api.pointRow(l, { ...a, x: 1500, y: 1500 }, a, api.errorFor(l, 1500, 1500, a)), p);
    const m = app.store.all('measurement').at(-1);
    const row = app.menRowOf(m);
    // Exact CE90 by quadrature vs the circular closed form; CE95; LE90 = 1.6449 σ.
    const s = 3;
    return { row, cols: Object.keys(row), ce90: app.core.ce90(s * s, 0, s * s), ce95: app.core.ce95(s * s, 0, s * s), ce90e: app.core.ce90(16, 0, 1), le90: app.core.le90(2), d: app.core.inverse(a.lat, a.lon, b.lat, b.lon).distance, sigma: m.sigma };
  });
  for (const k of ['value', 'units', 'method', 'model', 'heightSource', 'chain', 'ce90', 'le90', 'sigmaText', 'time']) expect(r.row[k], k).toBeTruthy();
  expect(r.row.ce90).not.toBe('N/A');
  expect(r.row.model).toMatch(/RPC00B/);
  expect(Math.abs(r.ce90 / 3 - 2.1460)).toBeLessThan(0.001);
  expect(Math.abs(r.ce95 / 3 - 2.4477)).toBeLessThan(0.001);
  expect(r.ce90e).toBeGreaterThan(1.645 * 4 * 0.99); // elliptical: between 1.645 σmax and 2.146 σmax
  expect(r.ce90e).toBeLessThan(2.146 * 4);
  expect(Math.abs(r.le90 / 2 - 1.6449)).toBeLessThan(0.0005);
  // Tracking: the status bar shows ground coordinates and the elevation source as the cursor moves.
  const box = await frame.locator('.multiport .pane').first().boundingBox();
  await page.mouse.move(box.x + 100, box.y + 120);
  await page.waitForTimeout(100);
  const g1 = await frame.locator('[data-id="status:ground"]').first().textContent();
  await page.mouse.move(box.x + 300, box.y + 260);
  await page.waitForTimeout(100);
  const g2 = await frame.locator('[data-id="status:ground"]').first().textContent();
  expect(g1).not.toBe(g2);
  await expect(frame.locator('[data-id="status:terrain"]').first()).toContainText(/Terrain/);
  // The error budget panel lists the σ inputs.
  await frame.evaluate(() => void window.gisworkbench.commands.run('model.error'));
  const dlg = frame.locator('.dlg').last();
  await expect(dlg).toContainText(/σ|sigma/i);
});

test('REQ-GEO-07 REQ-GEO-08 REQ-GEO-10 REQ-GEO-11 formats, conversion, slant geometry, GPS → UTC and the sun', async ({ page }) => {
  const { frame } = await withFx01(page);
  const t = truth01.points[0];
  const r = await frame.evaluate((t) => {
    const app = window.gisworkbench;
    const c = app.core;
    const usng = t.mgrs.replace(/^(\d+[A-Z])([A-Z]{2})(\d{5})(\d{5})$/, '$1 $2 $3 $4');
    const forms = [`${t.lat.toFixed(7)} ${t.lon.toFixed(7)}`, c.format(t.lat, t.lon, 1, 3), c.format(t.lat, t.lon, 2, 5), t.mgrs, usng];
    const u = c.utm(t.lat, t.lon);
    forms.push(`${u.zone}${u.north ? 'N' : 'S'} ${u.easting.toFixed(2)} ${u.northing.toFixed(2)}`);
    const parsed = forms.map((f) => {
      try {
        const r2 = c.parse(f);
        return { f, d: c.inverse(r2.lat, r2.lon, t.lat, t.lon).distance, format: r2.format };
      } catch (e) {
        return { f, error: e.message };
      }
    });
    const enu = c.enu(t.lat, t.lon, t.hae + 100, t.lat, t.lon, t.hae);
    const sl = c.slant({ lat: t.lat, lon: t.lon, h: t.hae }, { lat: t.lat + 0.01, lon: t.lon, h: t.hae + 500 });
    const gps = c.gpsToUnix(1e9); // 2011-09-14 01:46:40 GPS = 01:46:25 UTC (15 leap seconds then)
    const sun = c.sun(Date.UTC(2026, 2, 15, 18, 30) / 1000, t.lat, t.lon);
    return { parsed, enu, sl, gps, sun };
  }, t);
  for (const p of r.parsed) {
    expect(p.error, p.f).toBeUndefined();
    expect(p.d, p.f).toBeLessThan(2); // the 1 m MGRS cell is the coarsest form
  }
  expect(r.enu[2]).toBeCloseTo(100, 6);
  expect(r.sl.slant).toBeGreaterThan(1100);
  expect(r.sl.elevation).toBeGreaterThan(0);
  expect(new Date(r.gps * 1000).toISOString()).toBe('2011-09-14T01:46:25.000Z'); // 1e9 GPS s minus 15 leap seconds
  const ref = noaaSun(new Date(Date.UTC(2026, 2, 15, 18, 30)), t.lat, t.lon);
  expect(Math.abs(r.sun.azimuth - ref.azimuth)).toBeLessThan(0.1);
  expect(Math.abs(r.sun.elevation - ref.elevation)).toBeLessThan(0.1);
  await frame.evaluate(() => void window.gisworkbench.commands.run('geo.convert'));
  await expect(frame.locator('[data-id="dialog:convert"]')).toBeVisible();
});

test('REQ-SNS-06 REQ-SNS-07 REQ-SNS-08 model choice, ray–DEM crossings, error at every ground point', async ({ page }) => {
  const { frame } = await withFx01(page);
  await openFiles(frame, [DT2]);
  await frame.waitForFunction(() => window.gisworkbench.terrain.available);
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()].find((x) => /fx01/.test(x.rec.name));
    const names = l.models.filter((m) => !m.error).map((m) => m.name);
    app.store.transact('a', (tx) => tx.set(app.activePane().id, 'activeLayer', l.id));
    const items = app.commands.get('model.active').menu();
    const ig = items.find((i) => /^IGEOLO/.test(i.label));
    ig?.run();
    const switched = l.modelName;
    items.find((i) => /RPC00B/.test(i.label)).run();
    const dem = app.terrain.dems[0];
    const ray = app.core.rayDem(l.modelId, dem.coreId, 2048, 2048);
    const errs = [[100, 100], [2048, 2048], [4000, 3900]].map(([x, y]) => app.core.pointError(l.modelId, x, y, 650, 0.5).ce90);
    return { names, switched, back: l.modelName, ray, errs, status: document.querySelector('[data-id="status:model"]')?.textContent };
  });
  expect(r.names).toContain('RPC00B');
  expect(r.names.some((n) => /^IGEOLO/.test(n))).toBe(true);
  expect(r.switched).toMatch(/^IGEOLO/);
  expect(r.back).toBe('RPC00B');
  expect(r.status).toMatch(/RPC00B/);
  expect(r.ray.crossings?.length ?? r.ray.hits?.length ?? 0).toBeGreaterThanOrEqual(1);
  for (const e of r.errs) expect(Number.isFinite(e) && e > 0).toBe(true);
});

test('REQ-DEM-01 REQ-FMT-07 FX-05 DTED Level 2 reads with its UHL spacing and matches the analytic terrain', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  await openFiles(frame, [DT2]);
  await frame.waitForFunction(() => window.gisworkbench.terrain.available);
  const r = await frame.evaluate((pts) => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    return { meta: l.info.meta, size: [l.width, l.height], diffs: pts.map((t) => app.terrain.sample(t.lat, t.lon).hae - t.hae) };
  }, truth01.points);
  expect(r.size).toEqual([3601, 3601]);
  expect(r.meta.level).toBe('DTED2');
  expect(r.meta.checksumErrors).toBe(0);
  expect(r.meta.verticalDatum).toBe('E96');
  // Whole-metre EGM96 posts at 1″ (≈ 30 m) on a smooth surface: within 1.5 m everywhere.
  for (const d of r.diffs) expect(Math.abs(d)).toBeLessThan(1.5);
});

test('REQ-FMT-03 MUST TREs decode on real and written files: RPC00B, USE00A, ICHIPB, STDIDC/BLOCKA where present', async ({ page }) => {
  const { frame } = await withFx01(page);
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    return (l.info.subheader?.tres ?? []).map((t) => ({ tag: t.tag, complete: t.complete !== false }));
  });
  expect(r.find((t) => t.tag === 'RPC00B')?.complete).toBe(true);
  expect(r.find((t) => t.tag === 'USE00A')?.complete).toBe(true);
});

test('REQ-ARC-07 a single-block uncompressed NITF is read by byte ranges of at most 1 MiB', async ({ page }) => {
  const { frame } = await withFx01(page);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = app.activeLayer();
    const p = app.activePane();
    // Roam to the far corner and zoom in so new full-resolution tiles are read.
    p.setView({ cx: 3900, cy: 3900, zoom: 1, rot: 0, mode: 'native' });
    await new Promise((res) => setTimeout(res, 1500));
    const s = await app.pool.run('iostats', {}, { affinity: l.affinity });
    const px = await app.pool.run('pixels', { handle: l.handle, x: 4000, y: 4000, w: 2, h: 1, bands: [0] }, { affinity: l.affinity });
    return { s, sub: l.info.subheader, px: px.values[0] };
  });
  expect(r.sub.NBPR * r.sub.NBPC).toBe(1); // one 4096 × 4096 block (16 MiB)
  expect(r.s.largest).toBeLessThanOrEqual(2 ** 20);
  expect(r.s.reads).toBeGreaterThan(16);
  expect(r.px).toHaveLength(2);
});

test('REQ-ARC-11 the IndexedDB journal recovers unsaved edits after a reload; no OPFS needed', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.store.transact('Recover me', (tx) => tx.create('vlayer', { name: 'Journal test layer', visible: true, fields: [], source: { format: 'new' } }));
    await app.journal.flush();
  });
  const j = await frame.evaluate(async () => {
    const r = await window.gisworkbench.journal.recoverable();
    return { n: r?.changesets?.length ?? 0, opfs: typeof navigator.storage?.getDirectory };
  });
  expect(j.n).toBeGreaterThan(0);
  await page.reload();
  const f2 = page.mainFrame();
  await f2.waitForFunction(() => document.body.dataset.ready);
  const toast = f2.locator('.toast', { hasText: 'Unsaved work' });
  await expect(toast).toBeVisible({ timeout: 10000 });
  await toast.getByRole('button', { name: 'Recover' }).click();
  await f2.waitForFunction(() => window.gisworkbench.store.all('vlayer').some((v) => v.name === 'Journal test layer'));
  // Ops only, never pixels: the journal stores change sets, a few hundred bytes here.
  const size = await f2.evaluate(async () => JSON.stringify(await window.gisworkbench.journal.recoverable()).length);
  expect(size).toBeLessThan(20000);
});
