// SCN-78 REQ-GAP-85 geocoding and routing on the user's own data, through the commands, on the
// fixture city (fixtures/network, tests/tools/network_ref.py): an address index built from the
// address layer through its dialog; Find Address, the coordinate box and reverse geocoding; a CSV
// geocoded in a batch with a misspelling, a number written last and a street that does not exist;
// the index saved as a GeoPackage with its FTS4 table and opened again; a road network from the
// road layer through its dialog; routes whose travel times match scipy's Dijkstra on an
// independent graph, one-way detours included; and a service area reaching the reference nodes.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const DIR = resolve('fixtures/network');
const REF = JSON.parse(readFileSync(resolve(DIR, 'city.ref.json'), 'utf8'));
const CSV = readFileSync(resolve(DIR, 'city-queries.csv'), 'utf8');

test('SCN-78 REQ-GAP-85 geocode an address list and route on a city road layer, against the reference', async ({ page }) => {
  test.setTimeout(240000);
  const { frame, logs } = await openApp(page, 'file');
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    app.__saved = [];
    app.saveCapture = (blob, name) => app.__saved.push({ blob, name });
  });
  // An image with a georeference first, which the coordinate box needs.
  await openFiles(frame, [resolve('fixtures/timeseries/ndvi-2010-2019.nc')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 90000 });
  await openFiles(frame, [resolve(DIR, 'city-roads.geojson'), resolve(DIR, 'city-addresses.geojson')]);
  await frame.waitForFunction(() => window.gisworkbench.store.all('vlayer').length >= 2, null, { timeout: 60000 });

  // Address Index through its dialog: pick the address layer; the fields are guessed.
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('addr.index');
  });
  const dlg = frame.locator('[data-id="dialog:net-addresses"]');
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Address layer').selectOption({ label: 'city-addresses' });
  await expect(dlg.getByLabel('Street')).toHaveValue('addr_street');
  await expect(dlg.getByLabel('House number')).toHaveValue('addr_number');
  await expect(dlg.getByLabel('Place')).toHaveValue('city');
  await dlg.getByRole('button', { name: 'Build' }).click();
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.routing.geocoder?.index.count ?? 0)).toBe(528);

  // Find Address, the coordinate box, and reverse geocoding.
  const found = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const exact = await app.commands.run('addr.find', { query: '101 1st Street', show: false });
    const rev = await app.commands.run('addr.reverse', { at: [-104.99934, 40.00011] });
    return { exact: exact[0], rev };
  });
  expect(found.exact).toMatchObject({ match: 'exact', number: '101', street: '1st St', score: 100 });
  expect(found.exact.at).toEqual(REF.queries[0].at);
  expect(found.rev).toMatchObject({ match: 'point', number: '101', street: '1st St' });
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('nav.jump');
  });
  // Text that is not a coordinate is looked up in the address index.
  const jump = frame.locator('[data-id="dialog:jump"]');
  await expect(jump).toBeVisible();
  await jump.locator('input').fill('502 C Avenue');
  await expect(jump.locator('.hint')).toContainText('Address');
  await expect(jump.locator('.hint')).toContainText('502 C Avenue, 100%');
  await jump.locator('input').fill('Nowhere Lane');
  await expect(jump.locator('.hint')).toContainText('✗');
  await jump.getByRole('button', { name: 'Cancel' }).click();

  // A CSV in a batch.
  const batch = await frame.evaluate(async (text) => {
    const app = window.gisworkbench;
    const r = await app.commands.run('addr.batch', { text, address: 'address' });
    const fs = app.store.all('feature').filter((f) => f.vlayer === r.layer);
    return { matched: r.matched, unmatched: r.unmatched, failed: r.failed.map((f) => f.ref), rows: fs.map((f) => ({ ref: f.attrs.ref, at: [f.geom.xyz[0], f.geom.xyz[1]], match: f.attrs.match, score: f.attrs.score })) };
  }, CSV);
  expect(batch.matched).toBe(6);
  expect(batch.failed).toEqual(['q6']);
  for (const q of REF.queries.filter((x) => x.at)) {
    const row = batch.rows.find((r) => r.ref === q.ref);
    expect(row.at, q.ref).toEqual(q.at);
    expect(row.match, q.ref).toBe('exact');
  }
  // The misspelt street matches at a lower score than the exact ones.
  expect(batch.rows.find((r) => r.ref === 'q4').score).toBeLessThan(100);
  expect(batch.rows.find((r) => r.ref === 'q1').score).toBe(100);
  // A list of addresses with no delimiter is one column, its header included (the dialog reads the same
  // header): each line is searched whole, not by its first word.
  const one = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const r = await app.commands.run('addr.batch', { text: ['Full address', '101 1st Street', '1101 12th St', ''].join('\n'), address: 'Full address' });
    return { matched: r.matched, at: app.store.all('feature').filter((f) => f.vlayer === r.layer).map((f) => [f.geom.xyz[0], f.geom.xyz[1]]) };
  });
  expect(one.matched).toBe(2);
  expect(one.at).toEqual([REF.queries[0].at, REF.queries[2].at]);

  // The index as a GeoPackage, opened again.
  const gp = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const s = await app.routing.saveIndex();
    const f = app.__saved.at(-1);
    const bytes = new Uint8Array(await f.blob.arrayBuffer());
    app.routing.geocoder = null;
    const o = await app.routing.openIndex(bytes, f.name);
    const again = app.routing.geocode('1101 12th St', { limit: 1 })[0];
    return { name: f.name, saved: s.addresses, opened: o, again };
  });
  expect(gp.name).toMatch(/\.addresses\.gpkg$/);
  expect(gp.opened.addresses).toBe(528);
  expect(gp.again.at).toEqual(REF.queries[2].at);

  // The same index padded past the limit is refused by its row count, with the error that says to split it.
  const big = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const f = app.__saved.at(-1);
    const lib = await app.gw.runScript('js-sqlite');
    const module = await app.gw.wasm('wasm-sqlite');
    const SQL = await lib.initSqlJs({ instantiateWasm: (imports, ok) => (WebAssembly.instantiate(module, imports).then(ok), {}) });
    const db = new SQL.Database(new Uint8Array(await f.blob.arrayBuffer()));
    const table = db.exec("SELECT table_name FROM gpkg_contents WHERE data_type = 'features' LIMIT 1")[0].values[0][0];
    // The R*Tree triggers call ST_ functions this bare SQLite lacks; the rows need no geometry.
    for (const [name] of db.exec("SELECT name FROM sqlite_master WHERE type = 'trigger'")[0]?.values ?? []) db.run(`DROP TRIGGER "${name}"`);
    db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000) INSERT INTO "${table}" (geom) SELECT NULL FROM n`);
    const bytes = db.export();
    db.close();
    try {
      await app.routing.openIndex(bytes, 'big.addresses.gpkg');
      return { code: null };
    } catch (e) {
      return { code: e.code, still: app.routing.geocode('1101 12th St', { limit: 1 }).length };
    }
  });
  expect(big.code).toBe('E_NEED_SPLIT');
  // The index opened before is still the one in use.
  expect(big.still).toBe(1);

  // Road Network through its dialog: one-way and speed fields guessed, travel time.
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('route.roads');
  });
  const rd = frame.locator('[data-id="dialog:net-roads"]');
  await expect(rd).toBeVisible();
  await rd.getByLabel('Road layer').selectOption({ label: 'city-roads' });
  await expect(rd.getByLabel('One-way field')).toHaveValue('oneway');
  await expect(rd.getByLabel('Speed field (km/h)')).toHaveValue('speed');
  await rd.getByRole('button', { name: 'Build' }).click();
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.routing.graph?.g.edges.length ?? 0)).toBe(REF.edges);

  // Routes and a service area against scipy.
  const out = await frame.evaluate(async ({ routes, service }) => {
    const app = window.gisworkbench;
    const rs = [];
    for (const r of routes) {
      const x = await app.commands.run('route.shortest', { from: r.from, to: r.to });
      const f = app.store.all('feature').find((y) => y.vlayer === x.layer);
      rs.push({ cost: x.cost, time: f.attrs.time_s, length: f.attrs.length_m });
    }
    const s = await app.commands.run('route.service', { at: service.from, breaks: service.breaks });
    const nodes = app.routing.graph.g.nodes;
    return { rs, service: s, nodes: nodes.length };
  }, REF);
  out.rs.forEach((r, i) => {
    expect(Math.abs(r.cost - REF.routes[i].seconds) / REF.routes[i].seconds, `route ${i}`).toBeLessThan(5e-5);
    expect(r.time).toBeCloseTo(REF.routes[i].seconds, 0);
  });
  // A turn ban from a CSV: from the north-east corner to 1st St / B Ave the fastest way is down the
  // expressway and onto 1st St; banning that turn sends the route round the block.
  const ban = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const rl = app.store.all('vlayer').find((v) => v.name === 'city-roads').id;
    const from = [-104.9868, 40.0099];
    const to = [-104.9988, 40];
    const before = (await app.commands.run('route.shortest', { from, to })).cost;
    // A service area of exactly that time reaches 1st St / B Ave; with the turn banned it must not.
    const reaches = (id) => app.store.all('feature').filter((f) => f.vlayer === id).some((f) => { for (let i = 0; i < f.geom.xyz.length; i += 3) if (Math.hypot(f.geom.xyz[i] - to[0], f.geom.xyz[i + 1] - to[1]) < 2e-5) return true; return false; });
    const areaBefore = reaches((await app.commands.run('route.service', { at: from, breaks: [Math.ceil(before)] })).layer);
    const built = await app.commands.run('route.roads', { layer: rl, oneway: 'oneway', speed: 'speed', cost: 'time', idField: 'id', bansCsv: ['from,to', 'xw,st0', ''].join('\n') });
    const after = (await app.commands.run('route.shortest', { from, to })).cost;
    const areaAfter = reaches((await app.commands.run('route.service', { at: from, breaks: [Math.ceil(before)] })).layer);
    return { before, after, built, areaBefore, areaAfter };
  });
  expect(ban.built.banned).toBe(1);
  expect(ban.after).toBeGreaterThan(ban.before);
  expect(ban.after).toBeGreaterThan(Math.ceil(ban.before));
  expect([ban.areaBefore, ban.areaAfter]).toEqual([true, false]);
  // One-way 3rd St: west is a detour, east is not.
  expect(REF.routes[3].seconds).toBeGreaterThan(REF.routes[2].seconds);
  expect(out.service.nodes).toBe(REF.service.within['60'].length);
  expect(out.service.pieces).toBeGreaterThan(0);
  // Two clicks at one junction make no route, and no empty layer.
  const same = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const n = app.layers.size;
    const at = app.routing.graph.g.nodes[0];
    let code = null;
    await app.routing.route(at, at).catch((e) => (code = e.code));
    return { code, added: app.layers.size - n };
  });
  expect(same).toEqual({ code: 'E_NEED_ROADS', added: 0 });
  expect(logs).toEqual([]);
});
