// R1 extraction (REQ-EXT-01/02/04/05/06/08/12/21/23, AT-10.1, AT-17.2..17.4): capture tools with
// square, orthogonal, constant elevation and snapping; vertex editing with Snap Guard; split,
// merge and reshape; the attribute table and queries; GeoJSON, Shapefile, KML and KMZ round trips
// through the app with the round-trip report.
import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openApp, openFiles, sample } from './helpers.js';

const WV3 = sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf');

async function ready(page) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [WV3]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex && !l.tiles.loading && l.modelId));
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    app.activePane().setView({ cx: 768, cy: 768, zoom: 0.6, rot: 0.25, mode: 'native' });
    app.prefs.set('extract', { snap: true, tol: 10, ortho: false, square: false, constZ: false, z: 0, close: false, repeat: false, ngon: 16, snapGuard: 'warn' });
  });
  const box = await frame.locator('.multiport .pane').first().boundingBox();
  return { frame, logs, box };
}

/** Corner angles (degrees) of the outer ring of a feature, measured in ENU at its first vertex. */
const angles = (frame, id) =>
  frame.evaluate((id) => {
    const app = window.gisworkbench;
    const f = app.store.get(id);
    const n = f.geom.parts[1] ?? f.geom.xyz.length / 3;
    const v = Array.from({ length: n }, (_, i) => [f.geom.xyz[3 * i], f.geom.xyz[3 * i + 1], f.geom.xyz[3 * i + 2]]);
    const [lon0, lat0, h0] = v[0];
    const e = v.map(([lon, lat, h]) => app.core.enu(lat, lon, h, lat0, lon0, h0));
    return e.map((b, i) => {
      const a = e[(i + n - 1) % n];
      const c = e[(i + 1) % n];
      const a1 = Math.atan2(a[1] - b[1], a[0] - b[0]);
      const a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
      let d = (((a2 - a1) * 180) / Math.PI) % 360;
      if (d < 0) d += 360;
      return d > 180 ? 360 - d : d;
    });
  }, id);

const lastFeature = (frame) => frame.evaluate(() => window.gisworkbench.store.all('feature').at(-1));
const tool = (frame, id) => frame.evaluate((id) => window.gisworkbench.selectExtractTool(id), id);
const pref = (frame, patch) => frame.evaluate((p) => window.gisworkbench.prefs.set('extract', { ...window.gisworkbench.prefs.get('extract'), ...p }), patch);
const at = (box, fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];

test('REQ-EXT-01/02/05 AT-10.1 capture: squared polygon, 3-point rectangle, orthogonal, constant elevation, n-gon', async ({ page }) => {
  const { frame, logs, box } = await ready(page);
  // A rough quadrilateral, squared on finish.
  await pref(frame, { square: true });
  await tool(frame, 'ext.polygon');
  for (const [fx, fy] of [[0.3, 0.3], [0.52, 0.31], [0.53, 0.5], [0.29, 0.52]]) await page.mouse.click(...at(box, fx, fy));
  await page.keyboard.press('Enter');
  const sq = await lastFeature(frame);
  expect(sq.geom.type).toBe('Polygon');
  for (const a of await angles(frame, sq.id)) expect(Math.abs(a - 90)).toBeLessThan(0.1);
  // 3-point rectangle: exact right angles without squaring.
  await pref(frame, { square: false });
  await tool(frame, 'ext.rect3');
  for (const [fx, fy] of [[0.6, 0.6], [0.8, 0.65], [0.75, 0.8]]) await page.mouse.click(...at(box, fx, fy));
  const r3 = await lastFeature(frame);
  expect(r3.geom.xyz.length / 3).toBe(4);
  for (const a of await angles(frame, r3.id)) expect(Math.abs(a - 90)).toBeLessThan(1e-6);
  // Orthogonal polyline at a constant elevation.
  await pref(frame, { ortho: true, constZ: true, z: 123.5, snap: false });
  await tool(frame, 'ext.polyline');
  for (const [fx, fy] of [[0.2, 0.7], [0.4, 0.72], [0.47, 0.85]]) await page.mouse.click(...at(box, fx, fy));
  await page.keyboard.press('Enter');
  const ln = await lastFeature(frame);
  expect(ln.geom.type).toBe('LineString');
  expect([2, 5, 8].map((i) => ln.geom.xyz[i])).toEqual([123.5, 123.5, 123.5]);
  const la = await frame.evaluate((g) => {
    const app = window.gisworkbench;
    const [a, b, c] = [0, 1, 2].map((i) => app.core.enu(g.xyz[3 * i + 1], g.xyz[3 * i], g.xyz[3 * i + 2], g.xyz[1], g.xyz[0], g.xyz[2]));
    const u = [b[0] - a[0], b[1] - a[1]];
    const v = [c[0] - b[0], c[1] - b[1]];
    return (Math.acos((u[0] * v[0] + u[1] * v[1]) / Math.hypot(...u) / Math.hypot(...v)) * 180) / Math.PI;
  }, ln.geom);
  expect(Math.abs(la - 90)).toBeLessThan(0.01);
  // N-gon: 16 vertices at one radius.
  await pref(frame, { ortho: false, constZ: false, ngon: 16 });
  await tool(frame, 'ext.ngon');
  await page.mouse.click(...at(box, 0.15, 0.2));
  await page.mouse.click(...at(box, 0.2, 0.2));
  const ng = await lastFeature(frame);
  expect(ng.geom.xyz.length / 3).toBe(16);
  expect(ng.prov.image).toBeTruthy();
  expect(logs).toEqual([]);
});

test('REQ-EXT-04/06 snapping, vertex edits, Snap Guard, split, merge, reshape', async ({ page }) => {
  const { frame, logs, box } = await ready(page);
  await tool(frame, 'ext.rect3');
  for (const [fx, fy] of [[0.3, 0.3], [0.5, 0.3], [0.5, 0.5]]) await page.mouse.click(...at(box, fx, fy));
  const a = await lastFeature(frame);
  // A second polygon whose first vertex snaps onto a's corner (vertex snap copies X, Y, Z).
  const corner = await frame.evaluate((g) => {
    const app = window.gisworkbench;
    const s = app.activePane().screenPoint(...Object.values(app.activePane().geoLayer().imageAt(g.xyz[4], g.xyz[3], g.xyz[5])));
    const r = app.activePane().el.getBoundingClientRect();
    return [r.left + s.x, r.top + s.y];
  }, a.geom);
  await tool(frame, 'ext.polygon');
  await page.mouse.click(corner[0] + 4, corner[1] + 3);
  for (const [fx, fy] of [[0.7, 0.3], [0.7, 0.5]]) await page.mouse.click(...at(box, fx, fy));
  await page.keyboard.press('Enter');
  const b = await lastFeature(frame);
  expect(b.geom.xyz.slice(0, 3)).toEqual(a.geom.xyz.slice(3, 6));
  // Snap Guard "move together": dragging the shared vertex moves both features.
  await pref(frame, { snapGuard: 'together', snap: false });
  await frame.evaluate((id) => {
    const app = window.gisworkbench;
    app.selection.clear();
    app.selection.add(id);
    app.tools.select('sel.features', { sticky: true });
  }, b.id);
  await page.mouse.move(corner[0], corner[1]);
  await page.mouse.down();
  await page.mouse.move(corner[0] + 15, corner[1] + 10, { steps: 4 });
  await page.mouse.up();
  const [a2, b2] = await frame.evaluate(([x, y]) => [x, y].map((id) => window.gisworkbench.store.get(id).geom), [a.id, b.id]);
  expect(a2.xyz.slice(3, 6)).toEqual(b2.xyz.slice(0, 3));
  expect(a2.xyz[3]).not.toBe(a.geom.xyz[3]);
  // Delete and insert vertices; undo restores.
  const n0 = b2.xyz.length;
  const r = await frame.evaluate((id) => {
    const app = window.gisworkbench;
    const f = app.store.get(id);
    const g2 = f.geom;
    app.store.transact('ins', (tx) => tx.set(id, 'geom', { ...g2, xyz: [...g2.xyz.slice(0, 3), (g2.xyz[0] + g2.xyz[3]) / 2, (g2.xyz[1] + g2.xyz[4]) / 2, g2.xyz[2], ...g2.xyz.slice(3)] }));
    const n1 = app.store.get(id).geom.xyz.length;
    app.commands.run('qat.undo');
    return [n1, app.store.get(id).geom.xyz.length];
  }, b.id);
  expect(r).toEqual([n0 + 3, n0]);
  // Split polygon a along a line through it; the parts' areas add up.
  const split = await frame.evaluate((id) => {
    const app = window.gisworkbench;
    const f = app.store.get(id);
    const area = (g) => {
      // Orientation-free: a clockwise ring gives the rest of the ellipsoid.
      const a = app.core.polygonArea(Array.from({ length: g.parts[1] ?? g.xyz.length / 3 }, (_, i) => [g.xyz[3 * i + 1], g.xyz[3 * i]])).area;
      return Math.min(Math.abs(a), Math.abs(510065621724088.5 - Math.abs(a)));
    };
    const A = area(f.geom);
    const xs = f.geom.xyz.filter((_, i) => i % 3 === 0);
    const ys = f.geom.xyz.filter((_, i) => i % 3 === 1);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    app.splitPolygon(f, [[cx, Math.min(...ys) - 0.01], [cx, Math.max(...ys) + 0.01]]);
    const fs = app.store.all('feature').filter((x) => x.vlayer === f.vlayer && x.geom.type === 'Polygon');
    const parts2 = [app.store.get(id), fs.at(-1)];
    return { A, sum: parts2.reduce((s, x) => s + area(x.geom), 0), n: fs.length };
  }, a.id);
  // Clipping runs in lon/lat; the geodesic areas agree to well under a square centimetre here.
  expect(Math.abs(split.sum - split.A) / split.A).toBeLessThan(1e-4);
  // Merge the two halves back (union) and reshape a line.
  const m = await frame.evaluate((id) => {
    const app = window.gisworkbench;
    const f = app.store.get(id);
    const other = app.store.all('feature').at(-1);
    app.selection.clear();
    app.selection.add(f.id);
    app.selection.add(other.id);
    app.commands.run('ext.merge');
    const merged = app.store.get(id);
    const line = app.store.get(app.commitFeature(app.activePane(), 'LineString', [0, 1, 2, 3].map((i) => ({ lon: f.geom.xyz[0] + i * 1e-4, lat: f.geom.xyz[1], h: 0, zsrc: 'test' }))));
    app.reshapeFeature(line, [[f.geom.xyz[0] + 1e-4, f.geom.xyz[1], 0], [f.geom.xyz[0] + 1.5e-4, f.geom.xyz[1] + 5e-5, 0], [f.geom.xyz[0] + 2e-4, f.geom.xyz[1], 0]]);
    app.splitLine(app.store.get(line.id), [f.geom.xyz[0] + 2.5e-4, f.geom.xyz[1], 0]);
    return { type: merged.geom.type, exists: app.store.has(other.id), reshaped: app.store.get(line.id).geom.xyz.length / 3, lines: app.store.all('feature').filter((x) => x.geom.type === 'LineString').length };
  }, a.id);
  expect(m.type).toBe('Polygon');
  expect(m.exists).toBe(false);
  expect(m.reshaped).toBe(5); // v0, the three path points (ends replace v1 and v2), v3
  expect(m.lines).toBe(2);
  expect(logs).toEqual([]);
});

test('REQ-EXT-12 attribute table, select by attribute and location', async ({ page }) => {
  const { frame, logs } = await ready(page);
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const l = p.geoLayer();
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const g = l.groundAt(600 + i * 60, 700);
      ids.push(app.commitFeature(p, 'Point', [{ lon: g.lon, lat: g.lat, h: g.h, zsrc: 'test' }]));
    }
    app.store.transact('attrs', (tx) => ids.forEach((id, i) => tx.set(id, 'attrs', { kind: i % 2 ? 'tower' : 'mast', h: 10 + i })));
    const vl = app.store.get(ids[0]).vlayer;
    const byAttr = app.selectByAttribute(vl, 'kind', '=', 'tower');
    const tall = app.selectByAttribute(vl, 'h', '>', '12');
    app.selection.clear();
    app.selection.add(ids[0]);
    const near = app.selectByLocation(vl, 'within', app.core.inverse(app.store.get(ids[0]).geom.xyz[1], app.store.get(ids[0]).geom.xyz[0], app.store.get(ids[1]).geom.xyz[1], app.store.get(ids[1]).geom.xyz[0]).distance + 0.5);
    const inView = app.selectByLocation(vl, 'view');
    return { byAttr, tall, near, inView };
  });
  expect(r).toEqual({ byAttr: 2, tall: 2, near: 1, inView: 5 });
  await frame.evaluate(() => void window.gisworkbench.commands.run('ext.attrtable'));
  const table = frame.locator('[data-id="panel:attrtable"] table');
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(5);
  await frame.locator('[data-id="panel:attrtable"] input[type=search]').fill('tower');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  const cell = table.locator('tbody tr').first().locator('input').nth(1);
  await cell.fill('pylon');
  await cell.press('Tab');
  expect(await frame.evaluate(() => window.gisworkbench.store.all('feature').filter((f) => f.attrs.kind === 'pylon').length)).toBe(1);
  expect(logs).toEqual([]);
});

test('REQ-EXT-21/23 AT-17.2..17.4 GeoJSON, Shapefile, KML and KMZ round trips in the app', async ({ page }) => {
  const { frame, logs } = await ready(page);
  const dir = mkdtempSync(join(tmpdir(), 'gw-vec-'));
  const made = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const l = p.geoLayer();
    const g = (x, y) => {
      const q = l.groundAt(x, y);
      return { lon: q.lon, lat: q.lat, h: q.h + 7.25, zsrc: 'test' };
    };
    const a = app.commitFeature(p, 'Polygon', [g(600, 600), g(700, 600), g(700, 700), g(600, 700)]);
    const b = app.commitFeature(p, 'LineString', [g(500, 500), g(560, 540), g(620, 520)]);
    const c = app.commitFeature(p, 'Point', [g(650, 650)]);
    app.store.transact('attrs', (tx) => {
      tx.set(a, 'attrs', { name_long_attribute: 'مبنى', floors: 3, height: 12.5 });
      tx.set(a, 'name', 'Building 1');
      tx.set(a, 'description', 'Courtyard building');
      tx.set(b, 'attrs', { name_long_attribute: 'Дорога', floors: null, height: 0.5 });
      tx.set(c, 'attrs', { name_long_attribute: '塔', floors: 1, height: 30 });
    });
    const vl = app.store.get(a).vlayer;
    app.store.transact('style', (tx) => tx.set(vl, 'style', { stroke: '#00ff00', width: 3, fill: '#00ff0040', outline: '#00ff00', icon: 'files/icon.png' }));
    app.store.transact('asset', (tx) => tx.set(vl, 'assets', { 'files/icon.png': [137, 80, 78, 71, 13, 10, 26, 10] }));
    const out = {};
    for (const fmt of ['geojson', 'shp', 'kml', 'kmz']) {
      const e = app.encodeVectorLayer(vl, fmt);
      out[fmt] = { name: e.name, report: e.report };
    }
    return { vl, out, src: app.store.all('feature').map((f) => ({ type: f.geom.type, xyz: f.geom.xyz, attrs: f.attrs, name: f.name })) };
  });
  expect(made.out.shp.report.fields_renamed).toContainEqual(['name_long_attribute', 'name_long_']);
  expect(made.out.shp.report.fields_renamed).toContainEqual(['description', 'descriptio']); // names and descriptions travel as DBF fields
  // Write each encoding to disk, then open it like a user would.
  for (const fmt of ['geojson', 'shp', 'kml', 'kmz']) {
    const b64 = await frame.evaluate(async ([vl, fmt]) => {
      const e = window.gisworkbench.encodeVectorLayer(vl, fmt);
      const u8 = new Uint8Array(await e.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(s);
    }, [made.vl, fmt]);
    const file = join(dir, made.out[fmt].name);
    writeFileSync(file, Buffer.from(b64, 'base64'));
    if (fmt === 'geojson') {
      const j = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      expect(j.crs).toBeUndefined();
    }
    await openFiles(frame, [file]);
  }
  const back = await frame.evaluate((src) => {
    const app = window.gisworkbench;
    const byFormat = new Map();
    for (const v of app.store.all('vlayer').slice(1)) byFormat.set(v.source.format, [...(byFormat.get(v.source.format) ?? []), v]);
    return [...byFormat].map(([format, vs]) => {
      const v = { name: vs.map((x) => x.name).join('+'), source: { format }, assets: Object.assign({}, ...vs.map((x) => x.assets ?? {})) };
      const fs = app.store.all('feature').filter((f) => vs.some((x) => x.id === f.vlayer));
      const worst = { xy: 0, z: 0 };
      for (const s of src) {
        const f = fs.find((x) => x.geom.type === s.type);
        if (!f) return { name: v.name, missing: s.type };
        // Compare vertex sets (writers may reorder rings).
        for (let i = 0; i < s.xyz.length; i += 3) {
          let best = Infinity;
          let dz = 0;
          for (let j = 0; j < f.geom.xyz.length; j += 3) {
            const d = Math.hypot(f.geom.xyz[j] - s.xyz[i], f.geom.xyz[j + 1] - s.xyz[i + 1]);
            if (d < best) {
              best = d;
              dz = Math.abs(f.geom.xyz[j + 2] - s.xyz[i + 2]);
            }
          }
          worst.xy = Math.max(worst.xy, best);
          worst.z = Math.max(worst.z, dz);
        }
      }
      const poly = fs.find((x) => x.geom.type === 'Polygon');
      return { name: v.name, format: v.source.format, n: fs.length, worst, attrs: poly.attrs, fname: poly.name, desc: poly.description, style: poly.style, assets: Object.keys(v.assets ?? {}) };
    });
  }, made.src);
  expect(back).toHaveLength(4);
  for (const b of back) {
    expect(b.missing, b.format).toBeUndefined();
    expect(b.n, b.format).toBe(3);
    expect(b.worst.xy, b.format).toBeLessThan(1e-9);
    expect(b.worst.z, b.format).toBeLessThan(1e-3);
    const name = b.format === 'Shapefile' ? 'name_long_' : 'name_long_attribute';
    expect(b.attrs[name], b.format).toBe('مبنى');
    expect(Number(b.attrs.floors), b.format).toBe(3);
  }
  const kml = back.filter((b) => b.format === 'KML' || b.format === 'KMZ');
  for (const k of kml) {
    expect(k.fname).toBe('Building 1');
    expect(k.desc).toBe('Courtyard building');
    expect(k.style.stroke).toBe('#00ff00');
    expect(k.style.icon).toBe('files/icon.png');
  }
  expect(back.find((b) => b.format === 'KMZ').assets).toEqual(['files/icon.png']);
  expect(logs).toEqual([]);
});

test('REQ-EXT-01 ToolBox drawer and attribute table pass axe', async ({ page }) => {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  const { frame } = await ready(page);
  await frame.evaluate(axeSource);
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const g = p.geoLayer().groundAt(700, 700);
    app.commitFeature(p, 'Point', [{ lon: g.lon, lat: g.lat, h: g.h, zsrc: 'test' }]);
    void app.commands.run('dock.toolbox');
    void app.commands.run('ext.attrtable');
  });
  for (const sel of ['[data-id="panel:toolbox"]', '[data-id="panel:attrtable"]']) {
    await expect(frame.locator(sel)).toBeVisible();
    const v = await frame.evaluate(async (s) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), sel);
    expect(v, sel).toEqual([]);
  }
});
